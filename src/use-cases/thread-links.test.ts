import { describe, expect, it } from 'bun:test';
import type { ThreadRecord } from '../domain/mail-state.ts';
import { CONV, LINK_BODIES, THREAD_FILE, THREAD_FOLDER, THREAD_ID, THREAD_RELATIVE, message, run } from '../test-helpers/thread-harness.ts';

describe('following the SharePoint files a conversation points at', () => {
  const linked = { m1: [{ url: 'https://tenant.sharepoint.com/x', driveId: 'b!one', itemId: '01ABC', name: 'Rapport.docx' }] };
  // A linked file is read for its own metadata before it is converted, the same read a swept file
  // gets, so the day it last changed decides the folder it lands in.
  const REPORT = {
    id: '01ABC',
    name: 'Rapport.docx',
    kind: 'file' as const,
    size: 4096,
    path: 'Rapport.docx',
    lastModified: '2026-05-11T08:00:00Z',
    modifiedBy: 'Bruno Martin',
    cTag: 'c1',
    webUrl: 'https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx',
  };
  const items = { items: { '01ABC': REPORT } };
  // Beside the card standing for it, in the thread's own folder. The folders it had in SharePoint
  // are recorded in the card's `url` rather than rebuilt on disk: a library tree inside a thread
  // would bury one document four levels under the card that points at it.
  const LINKED_HERE = `kb/Mailbox/threads/${THREAD_FOLDER}/_linked`;
  const REPORT_MD = `${LINKED_HERE}/Rapport.docx.md`;

  // Asking costs a Graph call per message, and a full run asked a thousand times to find thirty-six
  // links. The body is already in hand by then, so it is what decides whether the question is worth
  // asking at all.
  it('a message pointing at nothing is never asked what it points at', async () => {
    const { reader } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked } });

    expect(reader.calls.filter((call) => call.startsWith('links:'))).toStrictEqual([]);
  });

  it('a linked document is pulled once and listed in the conversation head', async () => {
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });

    expect(files.written.has(REPORT_MD)).toBe(true);
    // Pinned whole rather than by its key: a reader follows this path from the folder the thread sits
    // in, so a value that resolves from the mailbox root instead would read as present and be broken.
    expect(files.written.get(THREAD_FILE)).toContain('linked_files:\n  - _linked/Rapport.docx.md');
    expect(outcome?.kind === 'rendered' && outcome.thread.linked['b!one:01ABC']).toEqual({ paths: [REPORT_MD] });
  });

  // A deck behind a link renders its slides before its text is read, which is minutes on the row of
  // the conversation that pointed at it; naming the document keeps that row from reading as stuck.
  it('a linked document is named on the conversation`s row while it is converted', async () => {
    const { progress } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });

    expect(progress.details).toEqual([{ label: 'Contrat Contoso', what: 'reading Rapport.docx' }]);
  });

  it('a document a thread pointed at gets a card beside the thread, naming its address at the source', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });
    const card = files.written.get(REPORT_MD) ?? '';

    expect(card).toContain(`linked_from: "${THREAD_ID}"`);
    expect(card).toContain('url: https://tenant.sharepoint.com/x');
    // The document's own text, carried into the card rather than linked from it: the two want the
    // same path, and one document per thing is what a reader opening the folder should find.
    expect(card).toContain('converted 01ABC');
  });

  // The card is the only place a thread's dependence on something the vault does not hold is
  // written down. Dropping it when the pull fails would make the gap invisible.
  it('a document that could not be pulled still gets a card, saying why it is not here', async () => {
    const { files } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
      drive: { failWith: { kind: 'permanent', message: 'gone' } },
    });
    const card = files.written.get(`kb/Mailbox/threads/${THREAD_FOLDER}/_linked/Rapport.docx.md`) ?? '';

    expect(card).toContain('url: https://tenant.sharepoint.com/x');
    expect(card).toContain('permanent: gone');
    expect(card).not.toContain('holds:');
  });

  // The card stands where the converter's own stamp used to, so it has to carry what that stamp
  // carried: not just the address, but which version of the document the thread meant.
  it('a linked document is stamped with where it came from, so it can be traced back', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });
    const written = files.written.get(REPORT_MD) ?? '';

    expect(written).toContain('url: https://tenant.sharepoint.com/x');
    expect(written).toContain('last_modified: "2026-05-11T08:00:00Z"');
    expect(written).toContain('modified_by: Bruno Martin');
    expect(written).toContain('in_message: "2026-05-12T09:31:00Z"');
  });

  it('a message whose links cannot be looked up leaves the other messages of the thread intact', async () => {
    const messages = [message({ id: 'm1' }), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })];
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, bodies: LINK_BODIES, links: { m2: linked.m1 } }, drive: items });

    expect(outcome?.kind).toBe('rendered');
    expect(files.written.has(REPORT_MD)).toBe(true);
  });

  // What somebody shares is as often a folder as a file. It was reaching the converter, which
  // refused it for having no extension, so a thread whose whole subject is "Frank Tao shared the
  // folder VMT with you" reported a file it could not read.
  it('a shared folder is recorded as a folder, not reported as a document that failed', async () => {
    const shared = { m1: [{ url: 'https://tenant.sharepoint.com/vmt', driveId: 'b!one', itemId: '01VMT', name: 'VMT' }] };
    const seeded = { items: { '01VMT': { ...REPORT, id: '01VMT', name: 'VMT', path: 'VMT', kind: 'folder' as const } } };
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: shared }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toStrictEqual([]);
    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toStrictEqual([]);
    // The card stands all the same: it is the record that the thread depended on what was shared.
    expect(files.written.get(`${LINKED_HERE}/VMT.md`) ?? '').toContain('It is a folder at the source, so there was nothing to pull.');
  });

  it('a linked file the drive will not hand over is named in the report as having failed', async () => {
    const { outcome, logger } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'permanent: fake has no item 01ABC' }]);
    // The log says WHICH document and why. An event with an empty payload names a failure nobody
    // can act on, which is the shape these lines quietly rot into.
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'linked.failed', meta: { itemId: '01ABC', name: 'Rapport.docx', cause: 'permanent' } });
  });

  it('a linked file of a kind this tool does not read is named in the report', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, name: 'Recording.mp4', path: 'Recording.mp4' } } };
    const { outcome, logger } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([
      { path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'a .mp4 file, which this tool does not read' },
    ]);
    // Skipped, not failed: the two are told apart in the log as well as in the report, since one is
    // a decision this tool made and the other is something that went wrong.
    expect(logger.calls).toContainEqual({
      level: 'warn',
      event: 'linked.skipped',
      meta: { itemId: '01ABC', name: 'Rapport.docx', cause: 'unsupported-type' },
    });
  });

  it('a linked file that could not be converted is named in the report, not lost between the two', async () => {
    const seeded = { items: { '01ABC': REPORT }, failItems: { '01ABC': { kind: 'permanent' as const, message: 'cannot convert' } } };
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'permanent: cannot convert' }]);
  });

  it('a document linked from two messages is listed once in the head, not once per message', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { files } = await run({ reader: { conversations, bodies: LINK_BODIES, links: { ...linked, m2: linked.m1 } }, drive: items });

    expect((files.written.get(THREAD_FILE) ?? '').match(/- _linked\/Rapport\.docx\.md/g)).toHaveLength(1);
    // And one card, not one per mention: a deck cited in four replies is one thing depended on.
    expect([...files.written.keys()].filter((path) => path.startsWith(`${LINKED_HERE}/`))).toEqual([REPORT_MD]);
  });

  // Pulled here even though another thread holds the same document. That is the trade this layout
  // makes: a report linked from ten threads is fetched ten times, so each folder reads on its own.
  it('a document another thread pulled is pulled here too, so this thread reads on its own', async () => {
    const already = { 'b!one:01ABC': { paths: ['kb/Mailbox/threads/other/_linked/Rapport.docx.md'] } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items, linked: already });

    expect(files.written.has(REPORT_MD)).toBe(true);
    expect(files.written.get(THREAD_FILE)).toContain('  - _linked/Rapport.docx.md');
  });

  it('a linked deck is kept as slides as well as text, the way a deck in a library is', async () => {
    const deck = { m1: [{ url: 'https://tenant.sharepoint.com/d', driveId: 'b!one', itemId: '01DECK', name: 'Deck.pptx' }] };
    const seeded = { items: { '01DECK': { ...REPORT, id: '01DECK', name: 'Deck.pptx', path: 'Deck.pptx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: deck }, drive: seeded });

    expect(files.binary.has(`${LINKED_HERE}/Deck.pptx.pdf`)).toBe(true);
    expect(files.written.has(`${LINKED_HERE}/Deck.pptx.md`)).toBe(true);
  });

  // The document is kept as it came as well as read, so the card can point at the file itself.
  // Which output that is, told by its name: a deck also renders a PDF, and a document with pictures
  // writes them out beside it, so "not the markdown" would have named whichever came first.
  it('a card names the document beside it, not whatever else the conversion produced', async () => {
    // A workbook, because reading one is never the whole of it: a formula, a second sheet and a
    // chart are in the file and nowhere else, so the file is kept and the card points at it.
    const book = { m1: [{ url: 'https://tenant.sharepoint.com/b', driveId: 'b!one', itemId: '01BOOK', name: 'Budget.xlsx' }] };
    const seeded = { items: { '01BOOK': { ...REPORT, id: '01BOOK', name: 'Budget.xlsx', path: 'Budget.xlsx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: book }, drive: seeded });

    expect(files.written.get(`${LINKED_HERE}/Budget.xlsx.md`) ?? '').toContain('original: Budget.xlsx\n');
  });

  // A deck renders slides as well as text. The card carries the TEXT, so the reading is what a
  // reader meets, and the slides are named beside it rather than opened as if they were words.
  it('a card carries the text a conversion produced, not another of its outputs', async () => {
    const deck = { m1: [{ url: 'https://tenant.sharepoint.com/d', driveId: 'b!one', itemId: '01DECK', name: 'Deck.pptx' }] };
    const seeded = { items: { '01DECK': { ...REPORT, id: '01DECK', name: 'Deck.pptx', path: 'Deck.pptx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: deck }, drive: seeded });

    expect(files.written.get(`${LINKED_HERE}/Deck.pptx.md`) ?? '').toContain('converted 01DECK');
  });

  // Once, however many messages of the thread cited it. The drive is asked for a document's own
  // metadata before it is pulled, and asking twice is a round trip per mention of a popular deck.
  it('a document two messages of a thread cite is fetched once, not once per mention', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { drive } = await run({ reader: { conversations, bodies: LINK_BODIES, links: { ...linked, m2: linked.m1 } }, drive: items });

    expect(drive.calls.filter((call: string) => call === 'item:01ABC')).toHaveLength(1);
  });

  // A thread whose links cannot be read at all still renders. The mailbox is asked per message and
  // the answer can fail on its own, separately from the drive refusing a document later.
  it('a message whose links the mailbox will not list costs that message, not the thread', async () => {
    const { outcome, files } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked, failCalls: { sharepointLinks: { kind: 'transient', message: 'timeout' } } },
      drive: items,
    });

    expect(outcome?.kind).toBe('rendered');
    expect(files.written.has(REPORT_MD)).toBe(false);
  });

  // Reported, the way a message whose attachments cannot be listed is: the thread is then written
  // again on the next run, and what it linked to comes back rather than being taken for gone.
  it('a message whose links the mailbox will not list is named as failed, so the thread is written again', async () => {
    const { outcome } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked, failCalls: { sharepointLinks: { kind: 'transient', message: 'timeout' } } },
      drive: items,
    });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: message m1`, reason: 'could not list what it links to: timeout' }]);
  });

  // Named by the document, not by the order of the messages: when the message linking an earlier
  // document of that name goes, the later one keeps its name rather than taking the one that came free.
  it('a linked document keeps its name when the message linking an earlier one of that name goes', async () => {
    const other = { url: 'https://tenant.sharepoint.com/z', driveId: 'b!one', itemId: '01DEF', name: 'Rapport.docx' };
    const both = { items: { '01ABC': REPORT, '01DEF': { ...REPORT, id: '01DEF' } } };
    const m2 = message({ id: 'm2', received: '2026-05-13T10:00:00Z' });
    const once = await run({ reader: { conversations: { [CONV]: [message(), m2] }, bodies: LINK_BODIES, links: { m1: linked.m1, m2: [other] } }, drive: both });
    const recordOf = (outcome: typeof once.outcome): ThreadRecord | undefined => (outcome?.kind === 'rendered' ? outcome.thread.record : undefined);
    const again = async (before: typeof once): Promise<typeof once> =>
      run({
        reader: { conversations: { [CONV]: [m2] }, bodies: LINK_BODIES, links: { m2: [other] } },
        drive: both,
        folder: THREAD_FOLDER,
        file: THREAD_RELATIVE,
        links: recordOf(before.outcome)?.links,
        held: recordOf(before.outcome)?.files,
        files: { texts: Object.fromEntries(before.files.written) },
      });
    const twice = await again(once);
    const thrice = await again(twice);

    expect(recordOf(once.outcome)?.files).toContain(`${LINKED_HERE}/Rapport-2.docx.md`);
    expect(recordOf(twice.outcome)?.files).toEqual([`${LINKED_HERE}/Rapport-2.docx.md`]);
    expect(recordOf(thrice.outcome)?.files).toEqual([`${LINKED_HERE}/Rapport-2.docx.md`]);
  });

  // The card of a document the thread pulled before holds its text: a failure written over it would be
  // read back as that text. It stays as it was, and what the document had beside it is named as unread.
  it('a linked document pulled before that cannot be pulled now keeps its card, and is named as unread', async () => {
    const once = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });
    const before = once.outcome?.kind === 'rendered' ? once.outcome.thread.record : undefined;

    const twice = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
      drive: { failWith: { kind: 'throttled', message: 'slow down' } },
      folder: THREAD_FOLDER,
      file: THREAD_RELATIVE,
      links: before?.links,
      held: before?.files,
      files: { texts: Object.fromEntries(once.files.written) },
    });
    const thread = twice.outcome?.kind === 'rendered' ? twice.outcome.thread : undefined;

    expect(twice.files.written.get(REPORT_MD)).toContain('converted 01ABC');
    expect(thread?.record.files).toEqual([REPORT_MD]);
    expect(thread?.unread).toEqual([`${LINKED_HERE}/Rapport.docx`]);
  });

  // Named by the item, so the message whose links went unread cannot say which were its own: every
  // document the thread linked keeps its name until a write that lists them all.
  it('a message whose links cannot be listed keeps the names of the documents the thread linked', async () => {
    const once = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });
    const before = once.outcome?.kind === 'rendered' ? once.outcome.thread.record : undefined;

    const twice = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked, failCalls: { sharepointLinks: { kind: 'transient', message: 'timeout' } } },
      drive: items,
      folder: THREAD_FOLDER,
      file: THREAD_RELATIVE,
      links: before?.links,
      held: before?.files,
    });

    expect(twice.outcome?.kind === 'rendered' && twice.outcome.thread.record.links).toEqual(before?.links);
  });

  // Any document the thread pointed at may still be linked from that message.
  it('a message whose links cannot be listed has every linked document named as unread', async () => {
    const { outcome } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked, failCalls: { sharepointLinks: { kind: 'transient', message: 'timeout' } } },
      drive: items,
    });

    expect(outcome?.kind === 'rendered' && outcome.thread.unread).toEqual([LINKED_HERE]);
  });

  // The converter cuts a long name to fit a deep disk, and the card has to take the same name: the card
  // reads the document's text back from it, and two files would leave the text beside a card without it.
  it('a linked document whose name is cut for length has one card, under the name its text was written under', async () => {
    const long = {
      url: 'https://tenant.sharepoint.com/y',
      driveId: 'b!one',
      itemId: '01LONG',
      name: 'Rahmenvertrag mit Contoso und Northwind bilingual Vorlage final Fassung zwei.docx',
    };
    const drive = { items: { '01LONG': { ...REPORT, id: '01LONG', name: long.name, path: long.name } } };
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: { m1: [long] } }, drive, pathBudget: 170 });
    const held = outcome?.kind === 'rendered' ? (outcome.thread.record.files ?? []) : [];

    expect(held).toHaveLength(1);
    expect(held[0]).toMatch(/-[0-9a-f]{8}\.docx\.md$/);
    expect(files.written.get(held[0] ?? '')).toContain('converted 01LONG');
    expect(files.written.get(held[0] ?? '')).toContain(`linked_from: "${THREAD_ID}"`);
  });

  // A card that could not be written is not on disk, so it is not one of the files the folder holds.
  it('a linked document whose card cannot be written is not listed among the files of the thread', async () => {
    const { outcome } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
      drive: items,
      files: { failWritesMatching: '/_linked/' },
    });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.files).toStrictEqual([]);
  });

  // A file the record still lists is on disk until a run moves it aside.
  it('a new linked document does not take the name of a file the thread folder still holds', async () => {
    const { outcome } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
      drive: items,
      folder: THREAD_FOLDER,
      links: {},
      held: [`${LINKED_HERE}/Rapport.docx.md`],
    });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.files).toEqual([`${LINKED_HERE}/Rapport-2.docx.md`]);
  });

  // Told apart by the document they stand for, not merely counted: a thread pointing at two things
  // gets two cards, and a key that failed to distinguish them would silently keep one.
  it('two documents one thread pointed at each get their own card', async () => {
    const both = {
      m1: [
        { url: 'https://tenant.sharepoint.com/x', driveId: 'b!one', itemId: '01ABC', name: 'Rapport.docx' },
        { url: 'https://tenant.sharepoint.com/y', driveId: 'b!one', itemId: '01DECK', name: 'Deck.pptx' },
      ],
    };
    const seeded = { items: { '01ABC': REPORT, '01DECK': { ...REPORT, id: '01DECK', name: 'Deck.pptx', path: 'Deck.pptx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: both }, drive: seeded });

    expect(files.written.has(REPORT_MD)).toBe(true);
    expect(files.written.has(`${LINKED_HERE}/Deck.pptx.md`)).toBe(true);
  });

  it('a linked file past the size cap is left where it is rather than pulled', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, size: 60 * 1024 * 1024 } } };
    const { files, logger } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    // A card is still written there, being the only record the thread depended on it. What is not
    // written is the document: the card says why, and names no original beside it.
    expect(files.written.get(REPORT_MD) ?? '').toContain('larger than the 50 MB cap');
    expect(files.written.get(REPORT_MD) ?? '').not.toContain('original:');
    expect(logger.calls.some((call) => call.event === 'linked.skipped')).toBe(true);
  });

  it('a linked file too large to pull is named in the report rather than passed over in silence', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, size: 60 * 1024 * 1024 } } };
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'larger than the 50 MB cap' }]);
  });

  // Flat, whatever tree it sat in at the source. A document three folders deep in a library would
  // otherwise land three folders away from the card that points at it, and the card already records
  // where it came from, so the tree is written down rather than rebuilt.
  it('a linked document sits beside its card, the folders it had at the source not rebuilt here', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, path: 'Decks/Q3/Rapport.docx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(files.written.has(REPORT_MD)).toBe(true);
    expect([...files.written.keys()].some((path) => path.includes('Decks/Q3'))).toBe(false);
  });

  it('the same document linked from two messages of a thread is listed once', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { outcome } = await run({ reader: { conversations, bodies: LINK_BODIES, links: { ...linked, m2: linked.m1 } }, drive: items });

    expect(outcome?.kind === 'rendered' && Object.keys(outcome.thread.linked)).toEqual(['b!one:01ABC']);
  });

  it('a linked document that cannot be written is reported and the conversation still lands', async () => {
    const { outcome, files, logger } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
      drive: items,
      files: { failWritesMatching: '_linked/' },
    });

    expect(outcome?.kind).toBe('rendered');
    expect(files.written.has(THREAD_FILE)).toBe(true);
    expect(logger.calls.some((call) => call.event === 'linked.failed')).toBe(true);
  });

  it('a message whose links cannot be looked up leaves the conversation intact', async () => {
    const { outcome, files } = await run({
      reader: { conversations: { [CONV]: [message()] }, failMessages: { m1: { kind: 'transient', message: 'timeout' } }, bodies: { m1: 'body' } },
    });

    expect(outcome).toBeUndefined();
    expect(files.written.size).toBe(0);
  });

  it('a linked document that cannot be read is reported and the conversation still lands', async () => {
    const { outcome, files, logger } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
      drive: { failWith: { kind: 'permanent', status: 403, message: 'no access' } },
    });

    expect(outcome?.kind).toBe('rendered');
    expect(files.written.has(THREAD_FILE)).toBe(true);
    expect(logger.calls.some((call) => call.event === 'linked.failed')).toBe(true);
  });
});
