import { describe, expect, it } from 'bun:test';
import type { AttachmentRecord } from './mail-state.ts';
import {
  countThreads,
  emptyMailboxState,
  filesLeft,
  filesOf,
  folderNames,
  marksChanged,
  needsRender,
  parseMailboxState,
  renamedFolders,
  retriedThreads,
  serializeMailboxState,
  storesWithout,
  threadOfConversation,
  threadsHolding,
  threadsInFolders,
  underName,
  withAttachment,
  withConversation,
  withFolderCursor,
  withLinked,
  withPending,
  withRetry,
  withOwnAddresses,
  withThread,
  withUnsweptFolders,
  withoutRetry,
} from './mail-state.ts';
import type { MessageRecord } from './message-record.ts';

const thread = {
  folder: '2026-05-12-a3f9c1e0d2-contrat',
  conversationIds: ['conv-1'],
  file: 'threads/2026/2026-05-12 Contrat a3f9c1.md',
  messageIds: ['m1', 'm2'],
  lastMessage: '2026-05-13T10:00:00Z',
  attachments: ['a.pdf'],
  inlineImages: [],
};

describe('remembering where a mailbox sync got to', () => {
  it('a mailbox never synced starts with no folders, threads or queue', () => {
    expect(emptyMailboxState()).toEqual({
      version: 2,
      source: { kind: 'mailbox', id: 'me', name: 'Mailbox' },
      fields: 2,
      lastRun: '',
      folders: {},
      threads: {},
      conversations: {},
      linked: {},
      attachments: {},
      pending: [],
      retry: {},
      titles: {},
      unsweptFolders: {},
      ownAddresses: [],
    });
  });

  it('the addresses the mailbox sends from read back, and a state from before them holds none', () => {
    const state = withOwnAddresses(emptyMailboxState(), ['jane@contoso.com']);
    const before = parseMailboxState({ version: 2, source: { kind: 'mailbox' } });

    expect(parseMailboxState(JSON.parse(serializeMailboxState(state)))).toEqual({ ok: true, value: state });
    expect(state.ownAddresses).toEqual(['jane@contoso.com']);
    expect(before.ok && before.value.ownAddresses).toStrictEqual([]);
  });

  it('the subjects kept for queued conversations read back, and a state from before them has none', () => {
    const written = serializeMailboxState({ ...emptyMailboxState(), pending: ['thread-1'], titles: { 'thread-1': 'Budget review' } });
    const notText = parseMailboxState({ version: 2, source: { kind: 'mailbox' }, titles: { 'thread-1': 42 } });
    const before = parseMailboxState({ version: 2, source: { kind: 'mailbox' } });

    expect(parseMailboxState(JSON.parse(written))).toMatchObject({ ok: true, value: { titles: { 'thread-1': 'Budget review' } } });
    expect(notText.ok && notText.value.titles).toEqual({});
    expect(before.ok && before.value.titles).toEqual({});
  });

  it('what one run writes, the next run reads back unchanged', () => {
    const linked = withLinked(withThread(withFolderCursor(emptyMailboxState(), 'AAMk1', 'Inbox', 'cursor-1'), 'conv-1', thread), 'b!one:01ABC', {
      paths: ['_linked/Contrat.docx.md'],
    });
    const state = withAttachment(linked, 'ba7816bf8f01', { name: 'Contrat.docx', paths: ['_attachments/Contrat.docx.md'], primary: '_attachments/Contrat.docx.md', media: [] });

    expect(parseMailboxState(JSON.parse(serializeMailboxState(state)))).toEqual({ ok: true, value: state });
  });

  it('a thread written with a record of each message reads them back', () => {
    const messages = [
      {
        id: 'm1',
        received: '2026-05-12T09:31:00Z',
        subject: 'Contrat',
        from: { name: 'Jane Doe', address: 'jane@contoso.com' },
        to: [],
        cc: [],
        folderId: 'AAMk-inbox',
        flag: 'notFlagged',
        importance: 'normal',
        categories: [],
        folder: 'Inbox',
        draft: false,
        internetMessageId: '<a@contoso.com>',
        preview: 'Hello.',
        attachments: [],
        linked: [],
      },
    ];
    const state = withThread(emptyMailboxState(), 'thread-1', { ...thread, messages });

    expect(parseMailboxState(JSON.parse(serializeMailboxState(state)))).toEqual({ ok: true, value: state });
  });

  // Absent, not zero: a state written before the fields were counted is one the next sweep updates.
  it('a state file written before the message fields were counted reads as having none', () => {
    const before = parseMailboxState({ version: 2, source: { kind: 'mailbox' } });
    const odd = parseMailboxState({ version: 2, source: { kind: 'mailbox' }, fields: '2' });

    expect(before.ok && before.value.fields).toBeUndefined();
    expect(odd.ok && odd.value.fields).toBeUndefined();
  });

  it('a state file written before the shared attachment store still loads', () => {
    const parsed = parseMailboxState({ version: 2, source: { kind: 'mailbox' } });

    expect(parsed.ok && parsed.value.attachments).toEqual({});
  });

  it('an attachment stored once is recorded by its content address, under the name it was stored as', () => {
    const record = { name: 'Scan.pdf', paths: ['_attachments/Scan.pdf', '_attachments/Scan.pdf.md'], primary: '_attachments/Scan.pdf.md', media: [] };
    const state = withAttachment(emptyMailboxState(), 'ba7816bf8f01', record);

    expect(state.attachments['ba7816bf8f01']).toEqual(record);
  });

  // Each thread keeps its own copy, and the index names one: the copy whose path sorts first, the
  // thread that began first. Named by the thread written last, the index changed with the order the
  // threads happened to render in.
  it('a file sent in two threads is named by the thread that began first, whichever thread was written last', () => {
    const copy = (folder: string, text?: string): AttachmentRecord => ({
      name: 'Scan.pdf',
      paths: [`${folder}/_attachments/Scan.pdf`],
      primary: `${folder}/_attachments/Scan.pdf.md`,
      media: [],
      text,
    });
    const first = copy('threads/2026-05-12-a1b2c3d4e5-scan');
    const later = copy('threads/2026-06-01-f6a7b8c9d0-scan');
    const hash = 'ba7816bf8f01';

    expect(withAttachment(withAttachment(emptyMailboxState(), hash, first), hash, later).attachments[hash]).toEqual(first);
    expect(withAttachment(withAttachment(emptyMailboxState(), hash, later), hash, first).attachments[hash]).toEqual(first);
    expect(withAttachment(withAttachment(emptyMailboxState(), hash, first), hash, copy('threads/2026-05-12-a1b2c3d4e5-scan', 'read')).attachments[hash]?.text).toBe('read');
  });

  it('a folder swept for the first time is recorded even before it has a cursor', () => {
    const state = withFolderCursor(emptyMailboxState(), 'AAMk1', 'Inbox', undefined);

    expect(state.folders['AAMk1']).toEqual({ name: 'Inbox' });
  });

  it('a state file belonging to a site is not mistaken for a mailbox', () => {
    expect(parseMailboxState({ source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is not a mailbox' },
    });
    expect(parseMailboxState('nope')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
  });

  // The threads of the version before this one were keyed by Graph's conversation id and named
  // paths under a tree that no longer exists. Half reading one would answer "already written" for
  // every conversation held and report a run that wrote nothing as a success.
  it('a state file from the layout before this one is refused, so a run does not read the old tree as current', () => {
    expect(parseMailboxState({ version: 1, source: { kind: 'mailbox' } })).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is version 1, not 2' } });
    expect(parseMailboxState({ source: { kind: 'mailbox' } }).ok).toBe(false);
  });

  it('a mailbox that recorded its own name and address keeps them', () => {
    const parsed = parseMailboxState({ version: 2, source: { kind: 'mailbox', id: 'valerie@example.com', name: 'Valerie inbox' } });

    expect(parsed.ok && parsed.value.source).toEqual({ kind: 'mailbox', id: 'valerie@example.com', name: 'Valerie inbox' });
  });

  it('a run date recorded as something other than text reads as never run', () => {
    const parsed = parseMailboxState({ version: 2, source: { kind: 'mailbox' }, lastRun: 20260722 });

    expect(parsed.ok && parsed.value.lastRun).toBe('');
  });

  it('a conversation recorded without the file it produced still loads', () => {
    const parsed = parseMailboxState({ version: 2, source: { kind: 'mailbox' }, threads: { 'conv-1': { messageIds: ['m1'] } } });

    expect(parsed.ok && parsed.value.threads['conv-1']).toEqual({
      folder: '',
      conversationIds: [],
      file: '',
      messageIds: ['m1'],
      lastMessage: '',
      attachments: [],
      inlineImages: [],
    });
  });

  it('entries recorded half-written load with what they do have rather than failing the run', () => {
    const parsed = parseMailboxState({
      version: 2,
      source: { kind: 'mailbox' },
      folders: { AAMk1: 'broken' },
      threads: { 'conv-1': { folder: '2026-05-12-a3f9c1e0d2-contrat', conversationIds: ['conv-1'], file: 'x.md', messageIds: ['m1', 7] } },
      pending: ['conv-1', 9],
    });

    expect(parsed.ok && parsed.value.folders).toEqual({});
    // The new fields are asserted as surviving, not as defaulting: a field added to the record and
    // forgotten in `threadOf` is dropped on reload without a word, and every thread would then look
    // as though it had never been filed anywhere.
    expect(parsed.ok && parsed.value.threads['conv-1']).toEqual({
      folder: '2026-05-12-a3f9c1e0d2-contrat',
      conversationIds: ['conv-1'],
      file: 'x.md',
      messageIds: ['m1'],
      lastMessage: '',
      attachments: [],
      inlineImages: [],
    });
    expect(parsed.ok && parsed.value.pending).toEqual(['conv-1']);
  });

  it('a state written on Windows reads back with forward slashes in every path it holds, so the next run compares like with like', () => {
    const parsed = parseMailboxState({
      version: 2,
      source: { kind: 'mailbox' },
      threads: { 'conv-1': { ...thread, file: 'threads\\T\\contrat.md', attachments: ['kb\\Mailbox\\_inline\\logo.gif'], inlineImages: ['kb\\Mailbox\\_inline\\logo.gif'] } },
      linked: { 'b!one:01ABC': { paths: ['kb\\Mailbox\\threads\\T\\_linked\\Rapport.docx.md'] } },
      attachments: {
        ba7816bf8f01: {
          name: 'Contrat.docx',
          paths: ['kb\\T\\_attachments\\Contrat.docx.md'],
          primary: 'kb\\T\\_attachments\\Contrat.docx.md',
          media: ['kb\\T\\_attachments\\Contrat.docx.media\\image1.png'],
        },
      },
    });

    expect(parsed.ok && parsed.value.threads['conv-1']).toMatchObject({
      file: 'threads/T/contrat.md',
      attachments: ['kb/Mailbox/_inline/logo.gif'],
      inlineImages: ['kb/Mailbox/_inline/logo.gif'],
    });
    expect(parsed.ok && parsed.value.linked['b!one:01ABC']).toEqual({ paths: ['kb/Mailbox/threads/T/_linked/Rapport.docx.md'] });
    expect(parsed.ok && parsed.value.attachments['ba7816bf8f01']).toMatchObject({
      paths: ['kb/T/_attachments/Contrat.docx.md'],
      primary: 'kb/T/_attachments/Contrat.docx.md',
      media: ['kb/T/_attachments/Contrat.docx.media/image1.png'],
    });
  });

  // A thread written before the list was kept has none, which is not the same as a thread whose
  // folder holds nothing but its note: the first falls back to its attachments, the second has none.
  it('the files a thread folder holds read back with forward slashes, and a thread written before the list was kept has none', () => {
    const parsed = parseMailboxState({
      version: 2,
      source: { kind: 'mailbox' },
      threads: {
        listed: { ...thread, files: ['kb\\Mailbox\\threads\\T\\_attachments\\a.pdf', 7] },
        empty: { ...thread, files: [] },
        before: thread,
        broken: { ...thread, files: 'a.pdf' },
      },
    });

    expect(parsed.ok && parsed.value.threads['listed']?.files).toEqual(['kb/Mailbox/threads/T/_attachments/a.pdf']);
    expect(parsed.ok && parsed.value.threads['empty']?.files).toStrictEqual([]);
    expect(parsed.ok && parsed.value.threads['before']?.files).toBeUndefined();
    expect(parsed.ok && parsed.value.threads['broken']?.files).toBeUndefined();
  });

  it('an attachment keeps the primary file it named, and one that named no file at all reads back with none', () => {
    const parsed = parseMailboxState({
      version: 2,
      source: { kind: 'mailbox' },
      attachments: {
        ba7816bf8f01: { name: 'Scan.pdf', paths: ['_attachments/Scan.pdf', '_attachments/Scan.pdf.md'], primary: '_attachments/Scan.pdf.md', media: [] },
        cafe00000001: { name: 'Lost.pdf' },
      },
    });

    expect(parsed.ok && parsed.value.attachments['ba7816bf8f01']?.primary).toBe('_attachments/Scan.pdf.md');
    expect(parsed.ok && parsed.value.attachments['cafe00000001']?.primary).toBe('');
  });

  it('the queue can be replaced as conversations are finished', () => {
    expect(withPending(emptyMailboxState(), ['conv-1', 'conv-2']).pending).toEqual(['conv-1', 'conv-2']);
  });

  // Frozen on purpose: a message arriving late, older than anything held, would otherwise answer
  // with a different root and rename a folder that is already on disk and already linked to.
  it('a conversation is recorded against the thread it belongs to and the message that decided it', () => {
    const state = withConversation(emptyMailboxState(), 'conv-1', { threadId: 'd9f4e0a3c1', root: '<root@example.com>' });

    expect(threadOfConversation(state, 'conv-1')).toEqual({ threadId: 'd9f4e0a3c1', root: '<root@example.com>' });
    expect(parseMailboxState(JSON.parse(serializeMailboxState(state)))).toEqual({ ok: true, value: state });
  });

  it('a conversation nobody has resolved yet belongs to no thread', () => {
    expect(threadOfConversation(emptyMailboxState(), 'conv-1')).toBeUndefined();
  });

  it('the picker counts one file per conversation', () => {
    expect(countThreads(withThread(emptyMailboxState(), 'conv-1', thread))).toBe(1);
  });
});

describe('deciding whether a conversation has to be written again', () => {
  // A thread is keyed by its own id, and the conversation that fed it points at it. Both halves are
  // needed: a conversation with no thread yet has nothing written to compare against.
  const state = withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'd9f4e0a3c1', root: '<root@example.com>' }), 'd9f4e0a3c1', thread);

  it('a conversation never seen before is written', () => {
    expect(needsRender(state, 'conv-new', ['m9'])).toBe(true);
  });

  it('a conversation pointing at a thread nothing has written yet is written', () => {
    const unwritten = withConversation(emptyMailboxState(), 'conv-2', { threadId: 'ffffffffff', root: '<other@example.com>' });

    expect(needsRender(unwritten, 'conv-2', ['m1'])).toBe(true);
  });

  it('a conversation that gained a reply is written again', () => {
    expect(needsRender(state, 'conv-1', ['m1', 'm2', 'm3'])).toBe(true);
  });

  it('a conversation whose messages are all known is left alone, whatever the sweep resurfaced', () => {
    expect(needsRender(state, 'conv-1', ['m1', 'm2'])).toBe(false);
    expect(needsRender(state, 'conv-1', ['m2'])).toBe(false);
    expect(needsRender(state, 'conv-1', [])).toBe(false);
  });
});

// A message flagged, filed elsewhere, given a category or an importance since its thread was written
// is a thread that says something no longer true. A message only read is not.
describe('telling whether a message was marked since its thread was written', () => {
  const recorded = (over: Partial<MessageRecord> = {}): MessageRecord => ({
    id: 'm1',
    received: '2026-05-12T09:31:00Z',
    subject: 'Contrat',
    to: [],
    cc: [],
    folderId: 'AAMk-inbox',
    flag: 'notFlagged',
    importance: 'normal',
    categories: ['Blue category'],
    folder: 'Inbox',
    draft: false,
    internetMessageId: '',
    preview: '',
    attachments: [],
    linked: [],
    ...over,
  });
  const marks = { id: 'm1', folderId: 'AAMk-inbox', flag: 'notFlagged', importance: 'normal', categories: ['Blue category'] };
  const filed = withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'd9f4e0a3c1', root: '<root@example.com>' }), 'd9f4e0a3c1', {
    ...thread,
    messages: [recorded()],
  });

  it('a message marked as it was when its thread was written leaves the thread alone', () => {
    expect(marksChanged(filed, 'conv-1', [marks])).toBe(false);
  });

  it('a message flagged since is a thread to write again', () => {
    expect(marksChanged(filed, 'conv-1', [{ ...marks, flag: 'flagged' }])).toBe(true);
    expect(marksChanged(filed, 'conv-1', [marks, { ...marks, flag: 'flagged' }])).toBe(true);
  });

  // A new message is what `needsRender` answers for, and a conversation nobody resolved has nothing
  // written to compare against.
  it('a message the thread never held, or a conversation no thread holds, has nothing to compare', () => {
    expect(marksChanged(filed, 'conv-1', [{ ...marks, id: 'm9', flag: 'flagged' }])).toBe(false);
    expect(marksChanged(filed, 'conv-new', [{ ...marks, flag: 'flagged' }])).toBe(false);
    expect(marksChanged(withConversation(emptyMailboxState(), 'conv-2', { threadId: 'none', root: '<r@example.com>' }), 'conv-2', [{ ...marks, flag: 'flagged' }])).toBe(false);
  });

  it('a thread written before its messages were recorded has no marks to compare', () => {
    const unmarked = withThread(filed, 'd9f4e0a3c1', thread);

    expect(marksChanged(unmarked, 'conv-1', [{ ...marks, flag: 'flagged' }])).toBe(false);
  });
});

describe('naming the folders of a mailbox', () => {
  it('the swept folders and the ones the sweep passes over are named together', () => {
    const state = withUnsweptFolders(withFolderCursor(emptyMailboxState(), 'AAMk-inbox', 'Inbox', 'c1'), [{ id: 'AAMk-bin', name: 'Deleted Items', childCount: 0, itemCount: 3 }]);

    expect(folderNames(state)).toEqual({ 'AAMk-bin': 'Deleted Items', 'AAMk-inbox': 'Inbox' });
    expect(parseMailboxState(JSON.parse(serializeMailboxState(state)))).toEqual({ ok: true, value: state });
  });

  // Replaced whole on each sweep, so a folder gone from the source is gone from the names too.
  it('the folders passed over are the ones the last sweep listed, and a name that is not text is dropped', () => {
    const once = withUnsweptFolders(emptyMailboxState(), [{ id: 'AAMk-bin', name: 'Deleted Items', childCount: 0, itemCount: 0 }]);
    const parsed = parseMailboxState({ version: 2, source: { kind: 'mailbox' }, unsweptFolders: { 'AAMk-bin': 'Deleted Items', 'AAMk-odd': 7 } });

    expect(withUnsweptFolders(once, []).unsweptFolders).toEqual({});
    expect(parsed.ok && parsed.value.unsweptFolders).toEqual({ 'AAMk-bin': 'Deleted Items' });
  });

  // A listing that names the same folders in another order changes nothing, so the state does not.
  it('the folders passed over are kept in a fixed order, whatever order the listing gave them in', () => {
    const folder = (id: string): { id: string; name: string; childCount: number; itemCount: number } => ({ id, name: id, childCount: 0, itemCount: 0 });

    expect(Object.keys(withUnsweptFolders(emptyMailboxState(), [folder('AAMk-junk'), folder('AAMk-bin')]).unsweptFolders)).toEqual(['AAMk-bin', 'AAMk-junk']);
  });

  it('a folder whose name changed is found, and one new or gone is not a rename', () => {
    expect(renamedFolders({ a: 'Follow', b: 'Inbox', gone: 'Old' }, { a: 'To_Follow', b: 'Inbox', fresh: 'New' })).toEqual(['a']);
  });

  it('the threads holding a message in a folder are found, each once, in a stable order', () => {
    const message = (folderId: string): MessageRecord => ({
      id: folderId,
      received: '',
      subject: '',
      to: [],
      cc: [],
      folderId,
      flag: '',
      importance: '',
      categories: [],
      folder: '',
      draft: false,
      internetMessageId: '',
      preview: '',
      attachments: [],
      linked: [],
    });
    const state = [
      ['t2', [message('a'), message('a')]],
      ['t1', [message('b'), message('a')]],
      ['t3', [message('b')]],
      ['t4', undefined],
    ].reduce((carried, [id, messages]) => withThread(carried, String(id), { ...thread, messages: messages as ReadonlyArray<MessageRecord> | undefined }), emptyMailboxState());

    expect(threadsInFolders(state, ['a'])).toEqual(['t1', 't2']);
    expect(threadsInFolders(state, [])).toStrictEqual([]);
  });
});

describe('telling which files a thread no longer holds', () => {
  const HERE = 'kb/Mailbox/threads/2026-05-12-a3f9c1e0d2-contrat';
  const written = { ...thread, files: [`${HERE}/_attachments/a.pdf`, `${HERE}/_attachments/a.pdf.md`, `${HERE}/_linked/Rapport.docx.md`] };

  it('a thread holds the files its last write listed, and a thread written before the list its attachments', () => {
    const before = { ...thread, attachments: [`${HERE}/_attachments/a.pdf.md`] };

    expect(filesOf(written)).toEqual(written.files);
    expect(filesOf(before)).toEqual([`${HERE}/_attachments/a.pdf.md`]);
  });

  // A picture shown in a body sits in the store the whole mailbox shares, and an older write could
  // list one among the attachments. It is not the thread's to put aside.
  it('a file outside the thread folder is not one of its files, and a thread filed nowhere holds none', () => {
    const shared = { ...thread, attachments: ['kb/Mailbox/_inline/logo-ab12.png', `${HERE}/_attachments/a.pdf.md`] };

    expect(filesOf(shared)).toEqual([`${HERE}/_attachments/a.pdf.md`]);
    expect(filesOf({ ...written, folder: '' })).toStrictEqual([]);
  });

  it('what the write before held and this one did not write is what the thread no longer holds', () => {
    const now = { ...written, files: [`${HERE}/_attachments/a.pdf.md`, `${HERE}/_attachments/b.pdf.md`] };

    expect(filesLeft(written, now)).toEqual([`${HERE}/_attachments/a.pdf`, `${HERE}/_linked/Rapport.docx.md`]);
    expect(filesLeft(undefined, now)).toStrictEqual([]);
    expect(filesLeft(written, written)).toStrictEqual([]);
  });

  // A record left behind would hand a later write a file that is no longer there.
  it('the stored records of files put aside go, and every other record stays', () => {
    const record = (primary: string): AttachmentRecord => ({ name: 'a.pdf', paths: [primary], primary, media: [] });
    const stores = {
      attachments: { gone: record(`${HERE}/_attachments/a.pdf.md`), kept: record(`${HERE}/_attachments/b.pdf.md`), elsewhere: record('kb/Mailbox/_inline/logo.png') },
      linked: {
        'b!one:01ABC': { paths: [`${HERE}/_linked/Rapport.docx.md`] },
        'b!one:01DEF': { paths: [`${HERE}/_linked/Plan.docx.md`] },
        'b!one:01GHI': { paths: [`${HERE}/_linked/Deck.pptx.md`, `${HERE}/_linked/Rapport.docx.md`] },
      },
    };

    expect(storesWithout(stores, [`${HERE}/_attachments/a.pdf.md`, `${HERE}/_linked/Rapport.docx.md`])).toEqual({
      attachments: { kept: stores.attachments.kept, elsewhere: stores.attachments.elsewhere },
      linked: { 'b!one:01DEF': { paths: [`${HERE}/_linked/Plan.docx.md`] } },
    });
  });
});

describe('telling the files under a name in a thread folder', () => {
  const AT = 'kb/Mailbox/threads/T/_attachments';

  it('a file, its card, its pictures and what it unpacked into are under its name, and a namesake is not', () => {
    expect(underName(`${AT}/Plan.pdf`, `${AT}/Plan.pdf`)).toBe(true);
    expect(underName(`${AT}/Plan.pdf.md`, `${AT}/Plan.pdf`)).toBe(true);
    expect(underName(`${AT}/Plan.pdf.media/image-01.png`, `${AT}/Plan.pdf`)).toBe(true);
    expect(underName(`${AT}/Projet X/Contrat.docx.md`, `${AT}/Projet X.zip`)).toBe(true);
    expect(underName(`${AT}/Plan-2.pdf`, `${AT}/Plan.pdf`)).toBe(false);
    expect(underName(`${AT}/Planning.pdf`, `${AT}/Plan.pdf`)).toBe(false);
  });

  // The converters name the folder an archive or a saved mail unpacks into the way they name any
  // segment: no space or dot at its end, a device name of Windows made safe.
  it('what an archive unpacked into is under its name as the converter cleaned it', () => {
    expect(underName(`${AT}/Minutes/part-1.md`, `${AT}/Minutes .eml`)).toBe(true);
    expect(underName(`${AT}/CON_/part-1.md`, `${AT}/CON.zip`)).toBe(true);
  });

  it('everything in a folder is under the name of the folder', () => {
    expect(underName('kb/Mailbox/threads/T/_linked/Rapport.docx.md', 'kb/Mailbox/threads/T/_linked')).toBe(true);
    expect(underName('kb/Mailbox/threads/T/_attachments/Rapport.docx.md', 'kb/Mailbox/threads/T/_linked')).toBe(false);
  });
});

describe('finding the threads a removed message was part of', () => {
  it('the threads holding any of the ids are found, each once, in a stable order', () => {
    const state = [
      ['t2', ['m1', 'm2']],
      ['t1', ['m3', 'm1']],
      ['t3', ['m4']],
    ].reduce((carried, [id, messageIds]) => withThread(carried, String(id), { ...thread, messageIds: messageIds as ReadonlyArray<string> }), emptyMailboxState());

    expect(threadsHolding(state, ['m1', 'm9'])).toEqual(['t1', 't2']);
    expect(threadsHolding(state, ['m9'])).toStrictEqual([]);
    expect(threadsHolding(state, [])).toStrictEqual([]);
  });
});

describe('remembering a conversation the run could not write', () => {
  const failed = { attempts: 1, reason: 'permanent: thread refused' };

  it('a state file written before failed threads were remembered loads with an empty ledger', () => {
    const parsed = parseMailboxState({ version: 2, source: { kind: 'mailbox' } });

    expect(parsed.ok && parsed.value.retry).toEqual({});
  });

  it('what one run remembers about a failed thread, the next run reads back unchanged', () => {
    const state = withRetry(emptyMailboxState(), 'd9f4e0a3c1', failed);

    expect(parseMailboxState(JSON.parse(serializeMailboxState(state)))).toEqual({ ok: true, value: state });
  });

  it('a remembered failure written with nothing usable in it loads as a first try with no reason', () => {
    const parsed = parseMailboxState({ version: 2, source: { kind: 'mailbox' }, retry: { d9f4e0a3c1: { attempts: 'lots' } } });

    expect(parsed.ok && parsed.value.retry['d9f4e0a3c1']).toEqual({ attempts: 0, reason: '' });
  });

  it('a thread remembered as failed is dropped once it renders', () => {
    expect(withoutRetry(withRetry(emptyMailboxState(), 'd9f4e0a3c1', failed), 'd9f4e0a3c1').retry).toEqual({});
  });

  it('a thread nothing failed on leaves the ledger untouched', () => {
    const remembered = withRetry(emptyMailboxState(), 'd9f4e0a3c1', failed);

    expect(withoutRetry(remembered, 'other')).toEqual(remembered);
  });

  it('a thread that failed last run is queued again although the sweep found nothing for it', () => {
    expect(retriedThreads(withRetry(emptyMailboxState(), 'd9f4e0a3c1', failed).retry, [])).toEqual(['d9f4e0a3c1']);
  });

  it('a thread the sweep queued again drops what an earlier run remembered about it', () => {
    expect(retriedThreads(withRetry(emptyMailboxState(), 'd9f4e0a3c1', failed).retry, ['d9f4e0a3c1'])).toStrictEqual([]);
  });

  it('a thread that has failed three times is left alone', () => {
    expect(retriedThreads(withRetry(emptyMailboxState(), 'd9f4e0a3c1', { attempts: 3, reason: 'permanent: thread refused' }).retry, [])).toStrictEqual([]);
  });
});
