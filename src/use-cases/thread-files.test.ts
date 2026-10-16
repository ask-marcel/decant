import { describe, expect, it } from 'bun:test';
import { contentHash } from '../domain/content-hash.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import { tooLargeReason } from '../domain/report.ts';
import type { AttachmentRecord, ThreadRecord } from '../domain/mail-state.ts';
import type { MailReaderSeed } from '../test-helpers/mail-reader-fake.ts';
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

  // A mail is not a file: the extension of its content type would rename a card the thread holds.
  it('keeps the name it came by, whatever content type Graph gives it', async () => {
    const typed = { ...EMBEDDED, contentType: 'message/rfc822' };
    const seed = { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: { m1: [typed] }, attachmentTexts: { att1: RENDERED } };
    const { files } = await run({ reader: seed });

    expect(files.written.has(`${ATTACHMENTS_STORE}/${renderedName(EMBEDDED.name)}.md`)).toBe(true);
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

  const recordOf = (outcome: Awaited<ReturnType<typeof run>>['outcome']): ThreadRecord | undefined => (outcome?.kind === 'rendered' ? outcome.thread.record : undefined);
  // Written again the way the sync does it: from the store, the names and the files the write before
  // left, into the folder and the note it was filed under.
  const again = async (before: Awaited<ReturnType<typeof run>>, reader: MailReaderSeed): Promise<Awaited<ReturnType<typeof run>>> =>
    run({
      reader,
      folder: THREAD_FOLDER,
      file: THREAD_RELATIVE,
      attachments: heldBy(before.outcome),
      names: recordOf(before.outcome)?.names,
      held: recordOf(before.outcome)?.files,
      files: { texts: Object.fromEntries(before.files.written) },
    });
  const tooLarge = (id: string, name = 'Budget.xlsx'): ReturnType<typeof budget> => ({ ...budget(id, name), size: 60 * 1024 * 1024 });

  // A card is all a file too large to fetch leaves, and it keeps its name as a converted file does:
  // the name does not move up when an earlier file of that name goes, neither now nor a write later.
  it('a file that left only a card keeps its name when an earlier file of that name goes, write after write', async () => {
    const once = await run({ reader: { conversations: { [CONV]: [m1, m2] }, attachments: { m1: [budget('att1')], m2: [tooLarge('att2')] } } });
    const reader = { conversations: { [CONV]: [m2] }, attachments: { m2: [tooLarge('att2')] } };
    const twice = await again(once, reader);
    const thrice = await again(twice, reader);

    expect(recordOf(once.outcome)?.files).toContain(`${second}.md`);
    expect(recordOf(twice.outcome)?.files).toEqual([`${second}.md`]);
    expect(recordOf(thrice.outcome)?.files).toEqual([`${second}.md`]);
  });

  // Its card takes the name first, so the file after it of the same name takes the next one.
  it('a file too large to fetch is never fetched, and keeps its name ahead of a file of that name after it', async () => {
    const once = await run({ reader: { conversations: { [CONV]: [m1, m2] }, attachments: { m1: [tooLarge('att1')], m2: [budget('att2')] } } });

    expect(once.reader.calls).not.toContain('attachmentBytes:att1:m1');
    expect(recordOf(once.outcome)?.files).toEqual([second, `${second}.md`, `${ATTACHMENTS_STORE}/Budget.xlsx.md`]);
  });

  // Three namesakes, the middle one gone: the third must keep its file, which a count of files alone
  // cannot tell from a rename.
  it('the third of three files of one name keeps its name when the message of the second goes', async () => {
    const once = await run({
      reader: { conversations: { [CONV]: [m1, m2, m3] }, attachments: { m1: [budget('att1')], m2: [budget('att2')], m3: [tooLarge('att3')] } },
    });
    const reader = { conversations: { [CONV]: [m1, m3] }, attachments: { m1: [budget('att1')], m3: [tooLarge('att3')] } };
    const twice = await again(once, reader);
    const thrice = await again(twice, reader);
    const first = `${ATTACHMENTS_STORE}/Budget.xlsx`;

    expect(recordOf(twice.outcome)?.files).toEqual([`${third}.md`, first, `${first}.md`]);
    expect(recordOf(thrice.outcome)?.files).toEqual([`${third}.md`, first, `${first}.md`]);
  });

  // A file the thread never held has no card to keep: the failure gets one, under the file's name, and
  // nothing of the thread is held back for it.
  it('a new file whose bytes cannot be fetched gets a card saying why, under its own name', async () => {
    const { outcome, files } = await run({
      reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1')] }, failCalls: { attachmentBytes: { kind: 'throttled', message: 'slow down' } } },
      folder: THREAD_FOLDER,
      names: {},
      held: [],
    });

    expect(files.written.get(`${ATTACHMENTS_STORE}/Budget.xlsx.md`)).toContain('throttled: slow down');
    expect(outcome?.kind === 'rendered' && outcome.thread.unread).toStrictEqual([]);
  });

  // Its content is held by another thread only, so this thread converts it again, under the name the
  // thread gave it first rather than the next one free.
  it('a file whose content the thread does not store keeps the name it was written under', async () => {
    const once = await run({ reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1')] } } });

    const twice = await run({
      reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1')] } },
      folder: THREAD_FOLDER,
      file: THREAD_RELATIVE,
      names: recordOf(once.outcome)?.names,
      held: recordOf(once.outcome)?.files,
      files: { texts: Object.fromEntries(once.files.written) },
    });

    expect(recordOf(twice.outcome)?.files).toEqual(recordOf(once.outcome)?.files);
  });

  // A thread written before the names were kept cannot tell what a failure was, so none of its files
  // is taken for gone until a write that reads everything.
  it('a thread written before the names were kept has its whole attachment folder named as unread on a failure', async () => {
    const { outcome } = await run({
      reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1')] }, failCalls: { attachmentBytes: { kind: 'throttled', message: 'slow down' } } },
      folder: THREAD_FOLDER,
      held: [`${ATTACHMENTS_STORE}/Budget.xlsx`],
    });

    expect(outcome?.kind === 'rendered' && outcome.thread.unread).toEqual([ATTACHMENTS_STORE]);
  });

  // Two messages can carry one RFC id, a draft's file can be replaced: a name stays with the content it
  // was given to, and a different content takes a name of its own rather than writing over it.
  it('two messages with one RFC id carrying different files of one name keep both', async () => {
    const one = message({ id: 'm1', internetMessageId: '<same@example.com>', hasAttachments: true });
    const two = message({ id: 'm2', internetMessageId: '<same@example.com>', received: '2026-05-13T10:00:00Z', hasAttachments: true });
    const { outcome } = await run({ reader: { conversations: { [CONV]: [one, two] }, attachments: { m1: [budget('att1', 'r.pdf')], m2: [budget('att2', 'r.pdf')] } } });

    expect(recordOf(outcome)?.attachments).toEqual([
      `${ATTACHMENTS_STORE}/r.pdf`,
      `${ATTACHMENTS_STORE}/r.pdf.md`,
      `${ATTACHMENTS_STORE}/r-2.pdf`,
      `${ATTACHMENTS_STORE}/r-2.pdf.md`,
    ]);
  });

  it('a file replaced under its own name in a draft gets a name of its own, and the one before is no longer written', async () => {
    const draft = message({ id: 'm1', internetMessageId: '<draft@example.com>', isDraft: true, hasAttachments: true });
    const once = await run({ reader: { conversations: { [CONV]: [draft] }, attachments: { m1: [budget('att1', 'r.pdf')] } } });

    const twice = await again(once, { conversations: { [CONV]: [draft] }, attachments: { m1: [budget('att9', 'r.pdf')] } });

    expect(recordOf(twice.outcome)?.attachments).toEqual([`${ATTACHMENTS_STORE}/r-2.pdf`, `${ATTACHMENTS_STORE}/r-2.pdf.md`]);
    expect(twice.files.written.get(`${ATTACHMENTS_STORE}/r.pdf.md`)).toContain('converted att1');
  });

  // Graph gives a mail a new id when it moves to another folder, where its RFC id stays.
  it('a file keeps its name when its message moves to another folder', async () => {
    const one = message({ id: 'm1', internetMessageId: '<one@example.com>', hasAttachments: true });
    const two = message({ id: 'm2', internetMessageId: '<two@example.com>', received: '2026-05-13T10:00:00Z', hasAttachments: true });
    const once = await run({ reader: { conversations: { [CONV]: [one, two] }, attachments: { m1: [tooLarge('att1', 'Plan.pdf')], m2: [tooLarge('att2', 'Plan.pdf')] } } });

    const twice = await again(once, { conversations: { [CONV]: [{ ...two, id: 'm2-moved' }] }, attachments: { 'm2-moved': [tooLarge('att2', 'Plan.pdf')] } });

    expect(recordOf(twice.outcome)?.files).toEqual([`${ATTACHMENTS_STORE}/Plan-2.pdf.md`]);
  });

  // A card holds the text read out of its file, and the next write reads the card back for that text:
  // a failure written over it would be taken for the text. The file keeps what it had, its name and
  // its card, and the write names it as failed.
  it('a file the thread held whose bytes cannot be fetched keeps its card and its name, and is named as failed', async () => {
    const once = await run({ reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1')] } } });

    const twice = await again(once, {
      conversations: { [CONV]: [m1] },
      attachments: { m1: [budget('att1')] },
      failCalls: { attachmentBytes: { kind: 'throttled', message: 'slow down' } },
    });
    const thread = twice.outcome?.kind === 'rendered' ? twice.outcome.thread : undefined;

    expect(twice.files.written.get(`${ATTACHMENTS_STORE}/Budget.xlsx.md`)).toContain('converted att1');
    expect(twice.files.written.has(`${second}.md`)).toBe(false);
    expect(thread?.record.files).toEqual(recordOf(once.outcome)?.files);
    expect(thread?.record.names).toEqual(recordOf(once.outcome)?.names);
    expect(thread?.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Budget.xlsx`, reason: 'throttled: slow down' }]);
  });

  // The same for a file that left only a card, or whose content another thread recorded first: what
  // it had beside the card is named as unread, so the run does not take it for gone.
  it('a file the thread held with no stored record keeps its card, and its other files are named as unread', async () => {
    const once = await run({ reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1')] } } });
    const named = recordOf(once.outcome);

    const twice = await run({
      reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1')] }, failCalls: { attachmentBytes: { kind: 'throttled', message: 'slow down' } } },
      folder: THREAD_FOLDER,
      file: THREAD_RELATIVE,
      names: named?.names,
      held: named?.files,
      files: { texts: Object.fromEntries(once.files.written) },
    });
    const thread = twice.outcome?.kind === 'rendered' ? twice.outcome.thread : undefined;

    expect(twice.files.written.get(`${ATTACHMENTS_STORE}/Budget.xlsx.md`)).toContain('converted att1');
    expect(thread?.record.files).toEqual([`${ATTACHMENTS_STORE}/Budget.xlsx.md`]);
    expect(thread?.unread).toEqual([`${ATTACHMENTS_STORE}/Budget.xlsx`]);
  });

  // Every file the message carried may still be there: none of them is taken for gone.
  it('a message whose files cannot be listed has every file it carried before named as unread', async () => {
    const once = await run({ reader: { conversations: { [CONV]: [m1, m2] }, attachments: { m1: [budget('att1')], m2: [budget('att2', 'Plan.pdf')] } } });

    const listing = await run({
      reader: { conversations: { [CONV]: [m1, m2] }, failAttachmentList: { kind: 'transient', message: 'timeout' } },
      folder: THREAD_FOLDER,
      file: THREAD_RELATIVE,
      names: recordOf(once.outcome)?.names,
      held: recordOf(once.outcome)?.files,
    });
    const thread = listing.outcome?.kind === 'rendered' ? listing.outcome.thread : undefined;

    expect(thread?.unread).toEqual([`${ATTACHMENTS_STORE}/Budget.xlsx`, `${ATTACHMENTS_STORE}/Plan.pdf`]);
    expect(thread?.record.names).toEqual(recordOf(once.outcome)?.names);
  });

  // A file the record still lists is on disk, whether its message went and it would not move, or it
  // is waiting on a read: a new file of that name takes the next one. A card alone is enough, since a
  // card is the name of its file plus `.md`.
  it('a new file does not take the name of a file the thread folder still holds', async () => {
    const { outcome } = await run({
      reader: { conversations: { [CONV]: [m1] }, attachments: { m1: [budget('att1', 'Old.pdf')] } },
      folder: THREAD_FOLDER,
      names: {},
      held: [`${ATTACHMENTS_STORE}/Old.pdf.md`],
    });

    expect(recordOf(outcome)?.attachments).not.toContain(`${ATTACHMENTS_STORE}/Old.pdf.md`);
    expect(recordOf(outcome)?.files).toContain(`${ATTACHMENTS_STORE}/Old-2.pdf.md`);
  });

  // A name cut to fit a deep disk is compared as it is written: the cut name a held file has is not
  // the name the sender gave, and a new file of that name would be cut to the same one.
  it('a held name cut for length keeps a new file of the same name off it', async () => {
    const long = 'Rahmenvertrag mit Contoso und Northwind bilingual Vorlage final.xlsx';
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

// A file is routed by the extension of its name. A name with none was skipped as a kind nothing reads,
// though Graph names its kind, and a picture named for another kind was read as that kind.
describe('a file whose name does not say what it is', () => {
  const carrying = (attachment: { id: string; name: string; contentType: string; size: number; isInline: boolean; contentId?: string }, raw: string): MailReaderSeed => ({
    conversations: { [CONV]: [message({ hasAttachments: true })] },
    bodies: attachment.isInline ? { m1: `\\[inline image: ${attachment.name}\\]` } : {},
    attachments: { m1: [attachment] },
    attachmentRaw: { [attachment.id]: raw },
  });

  it('a file sent with no extension is read as the kind its content type names', async () => {
    const { files } = await run({ reader: carrying({ id: 'att1', name: 'Scan', contentType: 'image/gif', size: 64 * 1024, isInline: false }, 'GIF89a') });

    expect(files.binary.has(`${ATTACHMENTS_STORE}/Scan.gif`)).toBe(true);
    expect(files.written.get(`${ATTACHMENTS_STORE}/Scan.gif.md`)).toContain('original: Scan.gif');
  });

  it('a picture whose bytes say another kind is stored under the extension of what it is, attached or shown', async () => {
    const attached = await run({ reader: carrying({ id: 'att1', name: 'logo.png', contentType: 'image/png', size: 64 * 1024, isInline: false }, 'GIF89a') });
    const shown = await run({
      reader: carrying({ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 64 * 1024, isInline: true, contentId: 'logo.png@01DC1234' }, 'GIF89a'),
    });

    expect(attached.files.binary.has(`${ATTACHMENTS_STORE}/logo.gif`)).toBe(true);
    expect([...shown.files.binary.keys()]).toStrictEqual([`${INLINE_STORE}/${disambiguateSegment('logo.gif', contentHash(new TextEncoder().encode('GIF89a')))}`]);
  });

  // The content type is known before a byte is fetched, so a file too large to fetch is named by it too.
  it('a file with no extension too large to fetch gets its card under the name its content type gives', async () => {
    const { files } = await run({ reader: carrying({ id: 'att1', name: 'Scan', contentType: 'image/gif', size: 60 * 1024 * 1024, isInline: false }, 'GIF89a') });

    expect(files.written.has(`${ATTACHMENTS_STORE}/Scan.gif.md`)).toBe(true);
  });

  // The report names a file the way the sender did, as its card and the message index do.
  it('a renamed file that fails is named in the report by the name the sender gave it', async () => {
    const { outcome } = await run({
      reader: carrying({ id: 'att1', name: 'logo.png', contentType: 'image/png', size: 64 * 1024, isInline: false }, 'GIF89a'),
      files: { failByteWritesMatching: 'logo.gif' },
    });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed.map((entry) => entry.path.split(': ').at(-1))).toStrictEqual(['logo.png']);
  });

  // A name a thread gave a file before stays, so a thread written again moves nothing for this.
  it('a file the thread named before keeps that name, whatever its bytes say', async () => {
    const { files } = await run({
      reader: carrying({ id: 'att1', name: 'logo.png', contentType: 'image/png', size: 64 * 1024, isInline: false }, 'GIF89a'),
      names: { 'm1|logo.png|0': 'logo.png' },
    });

    expect(files.binary.has(`${ATTACHMENTS_STORE}/logo.png`)).toBe(true);
  });
});

// A share link attached to a message is a reference, for which Graph holds no bytes. Asked for them,
// it failed every time, and the thread was named as failed three runs running beside the real file.
describe('a share link attached to a message', () => {
  const link = { id: 'ref1', name: 'Budget 2027.xlsx', contentType: '', size: 512, isInline: false, kind: 'reference' as const };
  const sharing = { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: { m1: [link] } };

  it('is not asked for bytes, fails nothing, and gets a card saying it is a link to a shared file', async () => {
    const { outcome, files, reader } = await run({ reader: sharing });

    expect(reader.calls.filter((call) => call.startsWith('attachmentBytes'))).toStrictEqual([]);
    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toStrictEqual([]);
    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toStrictEqual([]);
    expect(files.written.get(`${ATTACHMENTS_STORE}/Budget 2027.xlsx.md`)).toContain('a link to a shared file, not the file');
  });

  // Its size is the size of the link Graph keeps, not of the file, so no size cap applies to it.
  it('gets its card whatever size Graph gives it', async () => {
    const { files } = await run({ reader: { ...sharing, attachments: { m1: [{ ...link, size: 900 * 1024 * 1024 }] } } });

    expect(files.written.get(`${ATTACHMENTS_STORE}/Budget 2027.xlsx.md`)).toContain('a link to a shared file, not the file');
  });
});
