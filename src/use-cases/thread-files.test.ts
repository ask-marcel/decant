import { describe, expect, it } from 'bun:test';
import { contentHash } from '../domain/content-hash.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import { tooLargeReason } from '../domain/report.ts';
import type { AttachmentRecord } from '../domain/mail-state.ts';
import { compareText } from '../domain/utilities/compare-text.ts';
import { ATTACHMENTS_STORE, CONV, INLINE_STORE, THREAD_FILE, THREAD_FOLDER, THREAD_RELATIVE, bytesOf, message, run, storedName } from '../test-helpers/thread-harness.ts';

describe('keeping what a conversation carried', () => {
  const withAttachment = {
    conversations: { [CONV]: [message({ hasAttachments: true })] },
    attachments: { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] },
  };

  it('an attachment is converted once into the shared store and listed in the head', async () => {
    const { outcome, files } = await run({ reader: withAttachment });
    const stored = `${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}.md`;

    expect(files.written.has(stored)).toBe(true);
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([stored]);
  });

  // A thread folder sits three levels down, and a name a person typed can be long: on a deep disk the
  // two together passed what Windows accepts, and the file was never written.
  it('an attachment whose path would run past what Windows accepts is stored under a shorter name, its extension kept', async () => {
    const long = 'Rahmenvertrag mit AEB und BEB Software bilingual Vorlage final.docx';
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: long, contentType: 'application/vnd', size: 4096, isInline: false }] } };

    const { outcome } = await run({ reader, pathBudget: 170 });
    const stored = outcome?.kind === 'rendered' ? outcome.thread.record.attachments : [];

    expect(stored).toHaveLength(1);
    expect(stored[0]).toStartWith(`${ATTACHMENTS_STORE}/Rahmenvertrag mit AEB und BEB S-`);
    expect(stored[0]).toMatch(/-[0-9a-f]{8}\.docx\.md$/);
  });

  it('the head points at the shared store, climbing out of the thread folder to reach it', async () => {
    const { files } = await run({ reader: withAttachment });
    const written = files.written.get(THREAD_FILE) ?? '';

    expect(written).toContain('attachments:');
    expect(written).toContain('  - _attachments/Contrat.docx.md');
    expect(written).not.toContain('  - kb/Mailbox/');
  });

  it('the conversation records who wrote last, so a reader knows how fresh it is', async () => {
    const messages = [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z', from: { name: 'David Chang', address: 'd@example.com' }, hasAttachments: true })];
    const attachments = { m2: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(files.written.get(`${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}.md`)).toContain('sender: David Chang');
  });

  it('a revised file resent under the same name is stored beside the first, told apart by content', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = {
      m1: [{ id: 'att1', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
      m2: [{ id: 'att2', name: 'Budget.xlsx', contentType: 'application/vnd', size: 5120, isInline: false }],
    };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });
    const stored = outcome?.kind === 'rendered' ? outcome.thread.record.attachments : [];

    // Told apart by a number now, not by a content address: inside one thread that is all the
    // separation a pair of same-named files needs, and it reads better in a folder listing.
    const first = `${ATTACHMENTS_STORE}/Budget.xlsx`;
    const second = `${ATTACHMENTS_STORE}/Budget-2.xlsx`;

    expect(stored).toEqual([first, `${first}.md`, second, `${second}.md`]);
  });

  it('two files of one conversation sharing a name and a byte count are both kept, being different files', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = {
      m1: [{ id: 'att1', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
      m2: [{ id: 'att2', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
    };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });
    const stored = outcome?.kind === 'rendered' ? outcome.thread.record.attachments : [];

    const first = `${ATTACHMENTS_STORE}/Budget.xlsx`;
    const second = `${ATTACHMENTS_STORE}/Budget-2.xlsx`;

    expect(stored).toEqual([first, `${first}.md`, second, `${second}.md`]);
  });

  it('a signature image riding on every message is converted once, not once per message', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const signature = [{ id: 'sig', name: 'image001.png', contentType: 'image/png', size: 100, isInline: true }];
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments: { m1: signature, m2: signature } } });
    // Under `inline_images`, not `attachments`: no placeholder answered for it, and it is shown
    // after the text all the same, because a picture a message carried inline is part of it. One
    // entry for two messages, since the mailbox's picture store holds it once.
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toStrictEqual([]);
    expect(outcome?.kind === 'rendered' && outcome.thread.record.inlineImages).toEqual([`${INLINE_STORE}/${disambiguateSegment('image001.png', contentHash(bytesOf('sig')))}`]);
  });

  // Written here even though another thread holds the same bytes. That is the trade this layout
  // makes: a file arriving in two threads is written twice, so each folder reads on its own.
  it('a file another conversation holds is written here too, so this thread reads on its own', async () => {
    const store: Record<string, AttachmentRecord> = {
      [contentHash(bytesOf('att1'))]: {
        name: 'Contrat.docx',
        paths: ['kb/Mailbox/threads/other/_attachments/Contrat.docx.md'],
        primary: 'kb/Mailbox/threads/other/_attachments/Contrat.docx.md',
        media: [],
      },
    };
    const { outcome, files } = await run({ reader: withAttachment, attachments: store });

    expect(files.written.has(`${ATTACHMENTS_STORE}/Contrat.docx.md`)).toBe(true);
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/Contrat.docx.md`]);
  });

  it('a message flagged as carrying nothing is passed over even when attachments are listed for it', async () => {
    const messages = [message({ id: 'm1', hasAttachments: false })];
    const attachments = { m1: [{ id: 'att1', name: 'Ghost.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toStrictEqual([]);
  });

  it('an attachment whose bytes cannot be fetched is counted as failed, and the thread still lands', async () => {
    const { outcome, files } = await run({ reader: { ...withAttachment, failCalls: { attachmentBytes: { kind: 'transient', message: 'timeout' } } } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Contrat.docx`, reason: 'transient: timeout' }]);
    expect(files.written.has(THREAD_FILE)).toBe(true);
  });

  it('a too-large attachment adds nothing to what the conversation lists', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Enorme.docx', contentType: 'application/vnd', size: 60 * 1024 * 1024, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toStrictEqual([]);
  });

  // Named before its bytes are asked for, which is what lets a file nobody can read still be
  // accounted for. The thread lists nothing, so without the card the only trace that anything
  // arrived would be the run's report, which no reader of the vault ever opens.
  it('a file too large to fetch still gets a card, since a card is the only record that it came', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Enorme.docx', contentType: 'application/vnd', size: 60 * 1024 * 1024, isInline: false }] } };
    const { files } = await run({ reader });
    const card = files.written.get(`${ATTACHMENTS_STORE}/Enorme.docx.md`) ?? '';

    expect(card).toContain('filename: Enorme.docx');
    expect(card).toContain('sender: Jane Doe');
    expect(card).toContain(tooLargeReason(50 * 1024 * 1024));
  });

  it('a file of exactly the size allowed is kept, the cap being what may not be passed', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Pile.docx', contentType: 'application/vnd', size: 50 * 1024 * 1024, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/Pile.docx.md`]);
  });

  // `original:` is the card saying "the file itself is here, beside me". A conversion that yields
  // several outputs, a document with its pictures pulled out or a mail unpacked into its parts, has
  // no output that IS the file, and naming any of them is worse than naming none.
  it('a card names no original when none of the conversion outputs is the file itself', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const images = { att1: [{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments, attachmentImages: images } });
    const card = files.written.get(`${ATTACHMENTS_STORE}/Contrat.docx.md`) ?? '';

    expect(card).toContain('filename: Contrat.docx');
    expect(card).not.toContain('original:');
  });

  // A notification saying somebody shared a folder carries the icons its HTML is built from, named
  // by a machine id and carrying no extension, which is why nothing reads them. A card for one says
  // only that an unreadable thing with an unreadable name arrived, and thirteen of them buried the
  // two real files in the same vault. The run still counts them, so nothing goes unaccounted for.
  const ICON = { id: 'att1', name: 'a594de8f-caa3-427e-b800-23755374d464', contentType: 'image/png', size: 963, isInline: false };

  it('a refused file whose name is only a machine id is left out of the thread and the report alike', async () => {
    const messages = [message({ hasAttachments: true })];
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: { m1: [ICON] } } });

    expect(files.written.has(`${ATTACHMENTS_STORE}/${ICON.name}.md`)).toBe(false);
    expect(files.written.get(THREAD_FILE)).not.toContain(ICON.name);
    // Nor in the run's report. A report is what a reader should look into, and thirteen lines
    // saying an icon had no extension were the whole of one run's while nothing had gone wrong.
    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toStrictEqual([]);
  });

  // Both halves are needed. A machine id on a file that reads fine still yields a document worth
  // keeping, and the id is then the least of what the card says about it.
  it('a file named by a machine id is kept when something can read it after all', async () => {
    const messages = [message({ hasAttachments: true })];
    const readable = { m1: [{ ...ICON, name: `${ICON.name}.pdf` }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: readable } });

    expect(files.written.has(`${ATTACHMENTS_STORE}/${ICON.name}.pdf.md`)).toBe(true);
  });

  it('a refused file somebody named keeps its card, the name being the fact worth recording', async () => {
    const messages = [message({ hasAttachments: true })];
    const named = { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 10, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: named } });

    expect(files.written.get(`${ATTACHMENTS_STORE}/Demo.mp4.md`) ?? '').toContain('filename: Demo.mp4');
    expect(files.written.get(THREAD_FILE)).toContain('Demo.mp4');
  });

  it('an unsupported attachment adds nothing to what the conversation lists', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 10, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toStrictEqual([]);
  });

  it('an attachment whose bytes failed adds nothing to what the conversation lists', async () => {
    const { outcome } = await run({ reader: { ...withAttachment, failCalls: { attachmentBytes: { kind: 'transient', message: 'timeout' } } } });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toStrictEqual([]);
  });

  it('a message that carries nothing is never asked for its attachments', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] } } });

    expect(files.written.get(THREAD_FILE)).not.toContain('attachments:');
  });

  it('an attachment of a type this tool does not handle is counted, and the thread still lands', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 10, isInline: false }] } };
    const { outcome, files } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toHaveLength(1);
    expect(files.written.has(THREAD_FILE)).toBe(true);
  });

  it('a message whose attachment list cannot be read names the message and the reason', async () => {
    const { outcome, files } = await run({ reader: { ...withAttachment, failAttachmentList: { kind: 'transient', message: 'timeout' } } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: message m1`, reason: 'could not list what it carried: timeout' }]);
    expect(files.written.has(THREAD_FILE)).toBe(true);
  });

  it('an attachment left out names itself and why, so the report can say what is missing', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 10, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Demo.mp4`, reason: 'a .mp4 file, which this tool does not read' }]);
  });

  it('an attachment above the size cap says so, with the cap it exceeded', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Enorme.docx', contentType: 'application/vnd', size: 60 * 1024 * 1024, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Enorme.docx`, reason: 'larger than the 50 MB cap' }]);
  });

  it('an attachment locked with a password is left out rather than counted as a failure', async () => {
    const reader = { ...withAttachment, failCalls: { attachmentMarkdown: { kind: 'protected' as const, message: 'xlsx parse failed: File is password-protected' } } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([
      { path: `${THREAD_RELATIVE}: Contrat.docx`, reason: 'locked with a password, so nothing could be read from it' },
    ]);
    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toStrictEqual([]);
  });

  it('an attachment that could not be converted names itself and the reason', async () => {
    const { outcome } = await run({ reader: withAttachment, files: { failWritesMatching: '_attachments/' } });

    const failed = outcome?.kind === 'rendered' ? outcome.thread.filesFailed : [];

    expect(failed).toHaveLength(1);
    expect(failed[0]?.path.endsWith(': Contrat.docx')).toBe(true);
    expect(failed[0]?.reason.startsWith('write-failed: ')).toBe(true);
  });

  it('a message carrying nothing is never asked what it carried', async () => {
    const messages = [message({ id: 'm1', hasAttachments: false }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = { m2: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}.md`]);
  });

  it('an attachment Microsoft would not convert is counted as failed without losing the thread', async () => {
    const reader = {
      ...withAttachment,
      attachments: { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] },
      attachmentTexts: {},
    };
    const { outcome } = await run({ reader, files: { failWritesMatching: '_attachments/' } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toHaveLength(1);
  });
});

describe('the pictures a document attached to a mail holds', () => {
  it('are written beside its markdown and named nowhere in the head of the thread', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const images = { att1: [{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }] };
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, attachments, attachmentImages: images } });
    const stored = `${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}`;

    expect(files.binary.has(`${stored}.media/image-01.png`)).toBe(true);
    expect(files.written.get(THREAD_FILE)).not.toContain('image-01.png');
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${stored}.md`]);
  });

  it('are remembered against the document they came out of, so a second thread writes none of them again', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const images = { att1: [{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }] };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments, attachmentImages: images } });
    const stored = `${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}`;
    const record = outcome?.kind === 'rendered' ? outcome.thread.attachments[contentHash(bytesOf('att1'))] : undefined;

    expect(record?.paths).toEqual([`${stored}.md`, `${stored}.media/image-01.png`]);
    expect(record?.media).toEqual([`${stored}.media/image-01.png`]);
  });
});

// The one place the thread's own stamp reaches disk. A card is written over every document the
// converter produced at the top level, so what that stamp said is normally replaced; a saved email
// unpacks into a FOLDER, and the documents inside it are below the card's path and keep it.
describe('a saved email unpacked into its parts', () => {
  const EML = [
    'From: Mei Lin <mei@example.com>',
    'Subject: Fwd: Contrat',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    'Voici le contrat.',
    '--B',
    'Content-Type: application/vnd; name="Contrat.docx"',
    'Content-Transfer-Encoding: base64',
    '',
    'Q29udHJhdA==',
    '--B--',
  ].join('\n');

  it('the documents inside it say which mailbox they came out of', async () => {
    const carried = { m1: [{ id: 'att1', name: 'Fwd.eml', contentType: 'message/rfc822', size: 512, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: carried, attachmentRaw: { att1: EML } } });
    const inside = files.written.get(`${ATTACHMENTS_STORE}/Fwd/Contrat.docx.md`) ?? '';

    expect(inside).toContain(`source: conversation ${CONV}`);
    expect(inside).toContain('site: Mailbox');
    expect(inside).toContain('library: Mailbox');
  });
});

describe('an email attached to an email', () => {
  const EMBEDDED = { kind: 'item' as const, id: 'att1', name: 'Customs documents MSDU1691268', contentType: '', size: 2764134, isInline: false };
  const RENDERED = '**Subject:** Customs documents\n\nSee attached.';
  // Its address is the address of what it renders to, an item attachment having no bytes to take one
  // from, so the name on disk follows the rendering rather than anything Graph would hand back.
  // An item attachment lands under its plain name like anything else. Its content address still
  // decides whether it is converted twice within a thread; it just no longer decides its filename.
  const renderedName = (name: string): string => name;

  it('is kept and read, though Graph hands back no bytes for it', async () => {
    const messages = [message({ hasAttachments: true })];
    const seed = { conversations: { [CONV]: messages }, attachments: { m1: [EMBEDDED] }, attachmentTexts: { att1: RENDERED } };
    const { files } = await run({ reader: seed });
    const stored = `${ATTACHMENTS_STORE}/${renderedName(EMBEDDED.name)}.md`;

    expect(files.written.get(stored)).toContain('**Subject:** Customs documents');
    // Wrapped, because a bare destination ends at the first space and the rest of the path became
    // visible text: this is the name that showed the bug.
    expect(files.written.get(THREAD_FILE)).toContain('- [Customs documents MSDU1691268](<_attachments/Customs documents MSDU1691268.md>) (2.6 MB)');
  });

  it('is stored once, however many messages of the conversation forwarded it', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = { m1: [EMBEDDED], m2: [{ ...EMBEDDED, id: 'att2' }] };
    const seed = { conversations: { [CONV]: messages }, attachments, attachmentTexts: { att1: RENDERED, att2: RENDERED } };
    const { outcome } = await run({ reader: seed });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/${renderedName(EMBEDDED.name)}.md`]);
  });
});

describe('the names a thread already gave its files', () => {
  const budget = (id: string, name = 'Budget.xlsx'): { id: string; name: string; contentType: string; size: number; isInline: boolean } => ({
    id,
    name,
    contentType: 'application/vnd',
    size: 4096,
    isInline: false,
  });
  const second = `${ATTACHMENTS_STORE}/Budget-2.xlsx`;
  const third = `${ATTACHMENTS_STORE}/Budget-3.xlsx`;
  const m1 = message({ id: 'm1', hasAttachments: true });
  const m2 = message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true });
  const m3 = message({ id: 'm3', received: '2026-05-14T10:00:00Z', hasAttachments: true });

  const storedBy = (outcome: Awaited<ReturnType<typeof run>>['outcome']): ReadonlyArray<string> => (outcome?.kind === 'rendered' ? outcome.thread.record.attachments : []);
  const heldBy = (outcome: Awaited<ReturnType<typeof run>>['outcome']): Record<string, AttachmentRecord> => (outcome?.kind === 'rendered' ? { ...outcome.thread.attachments } : {});

  // The file a message kept stays under the name it was written under, and the new one takes a name
  // no file of the thread holds: given the name that came free, it wrote over the file kept there.
  it('a message gone from the thread leaves the names of the files after it as they were, and a new file takes a name no held file has', async () => {
    const before = await run({ reader: { conversations: { [CONV]: [m1, m2] }, attachments: { m1: [budget('att1')], m2: [budget('att2')] } } });

    const after = await run({
      reader: { conversations: { [CONV]: [m2, m3] }, attachments: { m2: [budget('att2')], m3: [budget('att3')] } },
      folder: THREAD_FOLDER,
      attachments: heldBy(before.outcome),
      files: { texts: Object.fromEntries(before.files.written) },
    });

    expect(storedBy(after.outcome)).toEqual([second, `${second}.md`, third, `${third}.md`]);
    expect(after.reader.calls).not.toContain('attachmentMarkdown:att2:m2');
    expect(after.files.written.get(`${second}.md`)).toContain('converted att2');
  });

  // Written in one go, the two files take the first two names: a held file takes no new name of its
  // own, so the file that joins it is numbered as though both had come together.
  it('a reply carrying a new file of the same name numbers it right after the held one', async () => {
    const before = await run({ reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1')] } } });

    const after = await run({
      reader: { conversations: { [CONV]: [m1, m2] }, attachments: { m1: [budget('att1')], m2: [budget('att2')] } },
      folder: THREAD_FOLDER,
      attachments: heldBy(before.outcome),
      files: { texts: Object.fromEntries(before.files.written) },
    });

    expect(storedBy(after.outcome)).toEqual([`${ATTACHMENTS_STORE}/Budget.xlsx`, `${ATTACHMENTS_STORE}/Budget.xlsx.md`, second, `${second}.md`]);
  });

  // Folded into the state by key, so a record handed back that the thread no longer holds would come
  // back after the run took it out. A new picture goes to the store the whole mailbox shares.
  it('the store a write hands back holds the files it used or added, not a held file whose message is gone', async () => {
    const logo = { id: 'sig', name: 'image001.png', contentType: 'image/png', size: 100, isInline: true };
    const before = await run({ reader: { conversations: { [CONV]: [m1, m2] }, attachments: { m1: [budget('att1')], m2: [budget('att2', 'Plan.xlsx')] } } });
    const other = { name: 'Other.pdf', paths: ['kb/Mailbox/threads/other/_attachments/Other.pdf'], primary: 'kb/Mailbox/threads/other/_attachments/Other.pdf', media: [] };

    const after = await run({
      reader: { conversations: { [CONV]: [m2] }, attachments: { m2: [budget('att2', 'Plan.xlsx'), logo] } },
      folder: THREAD_FOLDER,
      attachments: { ...heldBy(before.outcome), elsewhere: other },
      files: { texts: Object.fromEntries(before.files.written) },
    });
    const handed = after.outcome?.kind === 'rendered' ? Object.keys(after.outcome.thread.attachments).toSorted(compareText) : [];

    expect(handed).toEqual([contentHash(bytesOf('att2')), contentHash(bytesOf('sig'))].toSorted(compareText));
  });

  // A name cut to fit a deep disk is compared as it is written: the cut name a held file has is not
  // the name the sender gave, and a new file of that name would be cut to the same one.
  it('a held name cut for length keeps a new file of the same name off it', async () => {
    const long = 'Rahmenvertrag mit AEB und BEB Software bilingual Vorlage final.xlsx';
    const before = await run({ reader: { conversations: { [CONV]: [m1, m2] }, attachments: { m1: [budget('att1', long)], m2: [budget('att2', long)] } }, pathBudget: 170 });

    const after = await run({
      reader: { conversations: { [CONV]: [m2, m3] }, attachments: { m2: [budget('att2', long)], m3: [budget('att3', long)] } },
      folder: THREAD_FOLDER,
      attachments: heldBy(before.outcome),
      files: { texts: Object.fromEntries(before.files.written) },
      pathBudget: 170,
    });
    const was = storedBy(before.outcome);
    const now = storedBy(after.outcome);

    expect(was).toHaveLength(4);
    expect(now).toHaveLength(4);
    expect(now.slice(0, 2)).toEqual(was.slice(2, 4));
    expect(now.slice(2).filter((path) => was.includes(path))).toStrictEqual([]);
  });
});
