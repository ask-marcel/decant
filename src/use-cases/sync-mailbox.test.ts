import { describe, expect, it } from 'bun:test';
import type { MailFolder } from '../domain/mail-folder.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import { serializeMailboxState, emptyMailboxState, withConversation, withFolderCursor, withRetry, withThread } from '../domain/mail-state.ts';
import type { MailboxState, ThreadRecord } from '../domain/mail-state.ts';
import type { MessageRecord } from '../domain/message-record.ts';
import { threadIdOf } from '../domain/thread-id.ts';
import { err, ok } from '../domain/result.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createMailReaderFake } from '../test-helpers/mail-reader-fake.ts';
import type { MailReaderSeed } from '../test-helpers/mail-reader-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import type { RenderThreadInput, RenderThreadOutcome } from './render-thread.ts';
import { createSyncMailbox } from './sync-mailbox.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';
import type { StepError } from './ports/step-error.ts';

const STATE_PATH = 'kb/Mailbox/.sync-state.json';

const folder = (over: Partial<MailFolder> = {}): MailFolder => ({ id: 'AAMk-inbox', name: 'Inbox', childCount: 0, itemCount: 5, ...over });

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'm1',
  conversationId: 'conv-1',
  subject: 'Contrat Contoso',
  received: '2026-05-12T09:31:00Z',
  hasAttachments: false,
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [],
  isDeleted: false,
  ...over,
});

// Narrower than `RenderThreadOutcome` so a test can reach into the thread it describes; it still
// satisfies every seed that asks for the union.
type Rendered = Extract<RenderThreadOutcome, { readonly kind: 'rendered' }>;

const rendered = (over: Partial<Rendered> = {}): Rendered => ({
  kind: 'rendered',
  thread: {
    record: {
      folder: '2026-05-12-a3f9c1e0d2-thread',
      conversationIds: ['conv-1'],
      file: 'threads/2026-05-12/thread.md',
      messageIds: ['m1'],
      lastMessage: '2026-05-12T09:31:00Z',
      attachments: [],
      inlineImages: [],
    },
    linked: {},
    attachments: {},
    filesSkipped: [],
    filesFailed: [],
  },
  ...over,
});

const run = async (
  seeds: {
    reader?: MailReaderSeed;
    files?: FilesFakeSeed;
    dryRun?: boolean;
    since?: string;
    concurrency?: number;
    outcome?: (input: RenderThreadInput) => RenderThreadOutcome;
    failThread?: string;
  } = {}
): Promise<{
  summary: RunSummary;
  notes?: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  progress: ProgressFake;
  asked: string[];
  labels: string[];
  inputs: RenderThreadInput[];
  ok: boolean;
  error?: StepError;
  reader: ReturnType<typeof createMailReaderFake>;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const reader = createMailReaderFake(seeds.reader);
  const asked: string[] = [];
  const labels: string[] = [];
  const inputs: RenderThreadInput[] = [];
  const syncMailbox = createSyncMailbox({
    reader,
    files,
    logger,
    progress,
    clock: createClockFake(),
    kbRoot: 'kb',
    timezone: 'UTC',
    renderThread: async (input) => {
      asked.push(input.conversationIds.join(','));
      labels.push(input.label);
      inputs.push(input);
      if (seeds.failThread === input.conversationIds.join(',')) return err({ kind: 'permanent' as const, message: 'thread refused' });
      return ok(seeds.outcome === undefined ? rendered() : seeds.outcome(input));
    },
  });
  const result = await syncMailbox({
    maxBytes: 50 * 1024 * 1024,
    concurrency: seeds.concurrency ?? 1,
    dryRun: seeds.dryRun ?? false,
    since: seeds.since,
  });
  return {
    summary: result.ok ? result.value.summary : ({} as RunSummary),
    notes: result.ok ? result.value.notes : undefined,
    files,
    logger,
    progress,
    asked,
    labels,
    inputs,
    ok: result.ok,
    error: result.ok ? undefined : result.error,
    reader,
  };
};

const stateAfter = (
  files: FilesFake
): {
  folders: Record<string, { name: string; deltaLink?: string }>;
  threads: Record<string, unknown>;
  conversations: Record<string, { threadId: string; root: string }>;
  pending: string[];
  linked: Record<string, unknown>;
  attachments: Record<string, unknown>;
  retry: Record<string, { attempts: number; reason: string }>;
} => JSON.parse(files.written.get(STATE_PATH) ?? '{}');

describe('syncing a mailbox into the knowledge base', () => {
  it('a mailbox never synced writes one file per conversation it found', async () => {
    const { summary, asked } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(summary.converted).toBe(1);
    expect(asked).toEqual(['conv-1']);
  });

  // The identity is settled before anything renders, and settled once. A conversation resolved by
  // an earlier run is never asked again: re-reading it would let a message that arrived late, older
  // than anything held, answer with a different root and rename a folder already on disk.
  it('a conversation new to the run is asked once which thread it belongs to', async () => {
    const headers = { m1: [{ name: 'References', value: '<root@example.com>' }] };
    const { files, reader } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }], headers } });

    expect(reader.calls.filter((call) => call.startsWith('headers:'))).toEqual(['headers:m1']);
    expect(stateAfter(files).conversations['conv-1']).toEqual({ threadId: threadIdOf('<root@example.com>'), root: '<root@example.com>' });
  });

  // The oldest message of the sweep, not whichever arrived last in it. Reading the newest would
  // reach an unsent draft, which carries a newer time than any real message and no References at all.
  it('the oldest message of a conversation is the one asked, whatever order the sweep returned them in', async () => {
    const swept = [message({ id: 'm2', received: '2026-05-13T10:00:00Z' }), message({ id: 'm1', received: '2026-05-12T09:31:00Z' })];
    const { reader } = await run({ reader: { folders: [folder()], pages: [{ messages: swept, skipped: 0, deltaLink: 'c1' }] } });

    expect(reader.calls.filter((call) => call.startsWith('headers:'))).toEqual(['headers:m1']);
  });

  it('a conversation already resolved is never asked again', async () => {
    const held = serializeMailboxState(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'd9f4e0a3c1', root: '<root@example.com>' }));
    const { reader } = await run({
      files: { texts: { [STATE_PATH]: held } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
    });

    expect(reader.calls.filter((call) => call.startsWith('headers:'))).toStrictEqual([]);
  });

  // Left unresolved rather than guessed at. The root names a folder written once and never rebuilt,
  // so a guess is permanent where an absence is retried on the next sweep.
  it('a conversation whose root cannot be read is left unresolved and said so', async () => {
    const { files, logger, summary } = await run({
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }], failCalls: { messageHeaders: { kind: 'transient', message: 'throttled' } } },
    });

    expect(stateAfter(files).conversations).toEqual({});
    // Never queued: a thread cannot be rendered before it is known which one it is.
    expect(stateAfter(files).pending).toStrictEqual([]);
    expect(summary).toMatchObject({ converted: 0, skipped: 0, failed: 0 });
    expect(logger.calls.filter((call) => call.event === 'thread.unresolved')).toEqual([
      { level: 'warn', event: 'thread.unresolved', meta: { conversationId: 'conv-1', cause: 'transient' } },
    ]);
  });

  it('the cursor of every folder is stored, so the next run reads only what changed', async () => {
    const { files } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(stateAfter(files).folders['AAMk-inbox']).toEqual({ name: 'Inbox', deltaLink: 'cursor-1' });
  });

  it('folders nested inside another are swept too', async () => {
    const reader = {
      folders: [folder({ id: 'AAMk-follow', name: 'To_Follow', childCount: 1 })],
      children: { 'AAMk-follow': [folder({ id: 'AAMk-child', name: 'Projets' })] },
      pages: [
        { messages: [], skipped: 0, deltaLink: 'c1' },
        { messages: [], skipped: 0, deltaLink: 'c2' },
      ],
    };
    const { files } = await run({ reader });

    expect(Object.keys(stateAfter(files).folders)).toEqual(['AAMk-follow', 'AAMk-child']);
  });

  it('a folder holding no others is never asked what is inside it', async () => {
    const { reader } = await run({ reader: { folders: [folder({ childCount: 0 })], pages: [{ messages: [], skipped: 0, deltaLink: 'c1' }] } });

    expect(reader.calls.filter((call) => call.startsWith('folderDelta'))).toEqual(['folderDelta:AAMk-inbox']);
  });

  it('a second run follows the cursor it stored rather than sweeping the folder afresh', async () => {
    const known = serializeMailboxState({ ...emptyMailboxState(), folders: { 'AAMk-inbox': { name: 'Inbox', deltaLink: 'cursor-1' } } });
    const { reader } = await run({ files: { texts: { [STATE_PATH]: known } }, reader: { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'cursor-2' }] } });

    expect(reader.calls).toContain('deltaFrom:cursor-1');
    expect(reader.calls.some((call) => call.startsWith('folderDelta'))).toBe(false);
  });

  it('a message Graph returned without a conversation is passed over rather than queued alone', async () => {
    const { asked } = await run({ reader: { folders: [folder()], pages: [{ messages: [message({ conversationId: '' })], skipped: 0, deltaLink: 'c1' }] } });

    expect(asked).toStrictEqual([]);
  });

  it('the bin and the drafts are never swept at all', async () => {
    const reader = {
      folders: [folder(), folder({ id: 'AAMk-bin', name: 'Deleted Items' }), folder({ id: 'AAMk-drafts', name: 'Drafts' })],
      pages: [{ messages: [], skipped: 0, deltaLink: 'c1' }],
    };
    const { files } = await run({ reader });

    expect(Object.keys(stateAfter(files).folders)).toEqual(['AAMk-inbox']);
  });

  it('a conversation spanning several folders is written once, not once per folder', async () => {
    const reader = {
      folders: [folder(), folder({ id: 'AAMk-sent', name: 'Sent Items' })],
      pages: [
        { messages: [message({ id: 'in' })], skipped: 0, deltaLink: 'c1' },
        { messages: [message({ id: 'out', received: '2026-05-12T11:00:00Z' })], skipped: 0, deltaLink: 'c2' },
      ],
    };
    const { asked, summary } = await run({ reader });

    expect(asked).toEqual(['conv-1']);
    expect(summary.converted).toBe(1);
  });

  it('a message the sweep returned across several pages is still gathered', async () => {
    const reader = {
      folders: [folder()],
      pages: [
        { messages: [message({ id: 'm1', conversationId: 'conv-1' })], skipped: 0, nextLink: 'page-2' },
        { messages: [message({ id: 'm2', conversationId: 'conv-2', received: '2026-05-13T09:00:00Z' })], skipped: 0, deltaLink: 'cursor-1' },
      ],
    };
    const { asked } = await run({ reader });

    expect(asked).toEqual(['conv-1', 'conv-2']);
  });

  it('the oldest conversation is written first, so an interrupted run resumes in order', async () => {
    const messages = [
      message({ id: 'c', conversationId: 'conv-c', received: '2026-05-03T00:00:00Z' }),
      message({ id: 'a', conversationId: 'conv-a', received: '2026-05-01T00:00:00Z' }),
      message({ id: 'b', conversationId: 'conv-b', received: '2026-05-02T00:00:00Z' }),
    ];
    const { asked } = await run({ reader: { folders: [folder()], pages: [{ messages, skipped: 0, deltaLink: 'c1' }] } });

    expect(asked).toEqual(['conv-a', 'conv-b', 'conv-c']);
  });

  it('the queue empties as each conversation is finished, so a stop loses at most one', async () => {
    const { files } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] } });

    expect(stateAfter(files).pending).toStrictEqual([]);
  });

  // The queue holds threads, so a resumed run reads back which conversations each one covers rather
  // than working it out again: the sweep that would have told it is exactly what is being skipped.
  it('a run resumes at the thread it was stopped on, without sweeping again', async () => {
    const held = withConversation(emptyMailboxState(), 'conv-9', { threadId: 'thread-9', root: '<r@example.com>' });
    const halfDone = serializeMailboxState({ ...held, pending: ['thread-9'] });
    const { asked, logger } = await run({ files: { texts: { [STATE_PATH]: halfDone } }, reader: { folders: [folder()] } });

    expect(asked).toEqual(['conv-9']);
    expect(logger.calls.some((call) => call.event === 'mail.resuming')).toBe(true);
  });

  // The queue outlives a run, so a state file can carry a queue without the map behind it. Skipping
  // leaves the thread for the next sweep, which resolves its conversation again.
  it('a queue naming a thread no conversation points at is skipped rather than written empty', async () => {
    const halfDone = serializeMailboxState({ ...emptyMailboxState(), pending: ['thread-orphan'] });
    const { asked, summary, files } = await run({ files: { texts: { [STATE_PATH]: halfDone } }, reader: { folders: [folder()] } });

    expect(asked).toStrictEqual([]);
    expect(summary).toMatchObject({ converted: 0, skipped: 1 });
    expect(stateAfter(files).threads).toEqual({});
  });

  // Reused from the record, never recomputed: the naming rules are code, and a change to them must
  // not move a folder that is already written and already linked to.
  it('a thread already filed somewhere is rendered back into the folder it was filed under', async () => {
    const held = withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<r@example.com>' });
    const filed = withThread(held, 'thread-1', {
      folder: '2024-01-02-thread-1-an-older-name',
      conversationIds: ['conv-1'],
      file: 'threads/2024-01-02-thread-1-an-older-name/x.md',
      messageIds: ['m0'],
      lastMessage: '2026-05-11T00:00:00Z',
      attachments: [],
      inlineImages: [],
    });
    const folders: string[] = [];
    await run({
      files: { texts: { [STATE_PATH]: serializeMailboxState(filed) } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
      outcome: (input: RenderThreadInput): RenderThreadOutcome => {
        folders.push(input.folder);
        return rendered();
      },
    });

    expect(folders).toEqual(['2024-01-02-thread-1-an-older-name']);
  });

  // The note keeps its name the way the folder does, so a thread whose first message is gone does not
  // move its note to the name of the message after it.
  it('a thread already written is handed the path of its note, and a thread never written none', async () => {
    const held = withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<r@example.com>' });
    const filed = withThread(held, 'thread-1', {
      folder: '2024-01-02-thread-1-an-older-name',
      conversationIds: ['conv-1'],
      file: 'threads/2024-01-02-thread-1-an-older-name/an-older-name.md',
      messageIds: ['m0'],
      lastMessage: '2026-05-11T00:00:00Z',
      attachments: [],
      inlineImages: [],
    });
    const pages = [{ messages: [message()], skipped: 0, deltaLink: 'c1' }];

    const again = await run({ files: { texts: { [STATE_PATH]: serializeMailboxState(filed) } }, reader: { folders: [folder()], pages } });
    const fresh = await run({ reader: { folders: [folder()], pages } });

    expect(again.inputs.map((input) => input.file)).toEqual(['threads/2024-01-02-thread-1-an-older-name/an-older-name.md']);
    expect(fresh.inputs.map((input) => input.file)).toEqual([undefined]);
    expect(fresh.inputs).toHaveLength(1);
  });

  // A state lost or started over knows no folder, and the naming rules can name a thread otherwise
  // than they did when its folder was made. The id in the name is what the folder is found by.
  it('a thread the state holds no record of is written into the folder already on disk for its id', async () => {
    const id = threadIdOf('m1');
    const { inputs } = await run({
      files: { directories: { 'kb/Mailbox/threads': ['2026-05-12-0123456789-another-thread', `2026-05-11-${id}-an-older-name`] } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
    });

    expect(inputs.map((input) => input.folder)).toEqual([`2026-05-11-${id}-an-older-name`]);
  });

  // A record from an older state can hold no folder at all, which is the same as holding none.
  it('a thread recorded with no folder is written into the folder already on disk for its id', async () => {
    const id = threadIdOf('<r@example.com>');
    const held = withConversation(emptyMailboxState(), 'conv-1', { threadId: id, root: '<r@example.com>' });
    const blank = withThread(held, id, {
      folder: '',
      conversationIds: ['conv-1'],
      file: '',
      messageIds: ['m0'],
      lastMessage: '2026-05-11T00:00:00Z',
      attachments: [],
      inlineImages: [],
    });
    const { inputs } = await run({
      files: { texts: { [STATE_PATH]: serializeMailboxState(blank) }, directories: { 'kb/Mailbox/threads': [`2026-05-11-${id}-an-older-name`] } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
    });

    expect(inputs.map((input) => input.folder)).toEqual([`2026-05-11-${id}-an-older-name`]);
  });

  it('a thread filed nowhere yet is handed no folder, so the naming rules decide', async () => {
    const folders: string[] = [];
    await run({
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
      outcome: (input: RenderThreadInput): RenderThreadOutcome => {
        folders.push(input.folder);
        return rendered();
      },
    });

    expect(folders).toEqual(['']);
  });

  it('a window whose state cannot be saved ends the run naming the save step', async () => {
    const halfDone = serializeMailboxState({ ...emptyMailboxState(), pending: ['conv-9'] });
    const { ok: succeeded, error } = await run({
      files: { texts: { [STATE_PATH]: halfDone }, failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } },
      reader: { folders: [folder()] },
    });

    expect(succeeded).toBe(false);
    expect(error?.step).toBe('saveMailState');
  });
});

describe('running a mailbox sync again', () => {
  const known = serializeMailboxState(
    withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'd9f4e0a3c1', root: '<root@example.com>' }), 'd9f4e0a3c1', {
      folder: '2026-05-12-a3f9c1e0d2-thread',
      conversationIds: ['conv-1'],
      file: 'threads/2026-05-12/thread.md',
      messageIds: ['m1'],
      lastMessage: '2026-05-12T09:31:00Z',
      attachments: [],
      inlineImages: [],
    })
  );

  it('a conversation the sweep resurfaced unchanged is left alone', async () => {
    const { asked, summary } = await run({
      files: { texts: { [STATE_PATH]: known } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
    });

    expect(asked).toStrictEqual([]);
    expect(summary.converted).toBe(0);
  });

  // Outlook keeps a folder's sync state for only its last few generations and answers an older cursor
  // with 410. Only reading the folder from the start brings it back; what is already filed stays as it
  // is, since a conversation is written again only when it holds a message the state has not seen.
  it('a folder whose saved cursor Outlook has expired is read again from the start, rather than failing the mailbox', async () => {
    const cursored = serializeMailboxState(withFolderCursor(emptyMailboxState(), 'AAMk-inbox', 'Inbox', 'c-old'));
    const expired = { kind: 'permanent' as const, status: 410, message: 'SyncStateNotFound: The sync state generation is not found' };

    const {
      ok: succeeded,
      summary,
      reader,
      files,
      logger,
    } = await run({
      files: { texts: { [STATE_PATH]: cursored } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c-new' }], failCalls: { deltaFrom: expired } },
    });

    expect(succeeded).toBe(true);
    expect(reader.calls.filter((call) => call.startsWith('deltaFrom') || call.startsWith('folderDelta'))).toEqual(['deltaFrom:c-old', 'folderDelta:AAMk-inbox']);
    expect(summary.converted).toBe(1);
    expect(stateAfter(files).folders['AAMk-inbox']).toEqual({ name: 'Inbox', deltaLink: 'c-new' });
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'mail.cursor-expired', meta: { folderId: 'AAMk-inbox' } });
  });

  it('a saved cursor refused for any other reason still ends the mailbox run, naming the sweep', async () => {
    const cursored = serializeMailboxState(withFolderCursor(emptyMailboxState(), 'AAMk-inbox', 'Inbox', 'c-old'));

    const { ok: succeeded, error } = await run({
      files: { texts: { [STATE_PATH]: cursored } },
      reader: { folders: [folder()], failCalls: { deltaFrom: { kind: 'permanent', status: 403, message: 'Forbidden' } } },
    });

    expect(succeeded).toBe(false);
    expect(error).toEqual({ step: 'sweepFolder', cause: 'permanent', message: 'Forbidden' });
  });

  it('a conversation that gained a reply is written again, in place', async () => {
    const reader = { folders: [folder()], pages: [{ messages: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })], skipped: 0, deltaLink: 'c1' }] };
    const { asked } = await run({ files: { texts: { [STATE_PATH]: known } }, reader });

    expect(asked).toEqual(['conv-1']);
  });
});

// A flag, a category, an importance or a move changes what a thread's note says about a message, and
// none of them adds a message. Reading one changes nothing a note says.
describe('writing a thread again when one of its messages is marked', () => {
  const recorded = (over: Partial<MessageRecord> = {}): MessageRecord => ({
    id: 'm1',
    received: '2026-05-12T09:31:00Z',
    subject: 'Contrat Contoso',
    from: { name: 'Jane Doe', address: 'jane@example.com' },
    to: [],
    cc: [],
    folderId: 'AAMk-inbox',
    flag: 'notFlagged',
    importance: 'normal',
    categories: [],
    folder: 'Inbox',
    draft: false,
    internetMessageId: '',
    preview: '',
    attachments: [],
    linked: [],
    ...over,
  });
  const filedWith = (messages: ReadonlyArray<MessageRecord> | undefined): MailboxState =>
    withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<root@example.com>' }), 'thread-1', {
      folder: '2026-05-12-thread-1',
      conversationIds: ['conv-1'],
      file: 'threads/2026-05-12-thread-1/contrat-contoso.md',
      messageIds: ['m1'],
      lastMessage: '2026-05-12T09:31:00Z',
      attachments: [],
      inlineImages: [],
      subject: 'Contrat Contoso',
      messages,
    });
  const filed = (): MailboxState => filedWith([recorded()]);
  const sweeping = (over: Partial<MailMessage> = {}): MailReaderSeed => ({
    folders: [folder()],
    pages: [{ messages: [message({ folderId: 'AAMk-inbox', flag: 'notFlagged', importance: 'normal', categories: [], ...over })], skipped: 0, deltaLink: 'c1' }],
  });
  const runOn = async (state: MailboxState, reader: MailReaderSeed, since?: string): Promise<string[]> =>
    (await run({ files: { texts: { [STATE_PATH]: serializeMailboxState(state) } }, reader, since })).asked;

  it('a message flagged since its thread was written writes the thread again', async () => {
    expect(await runOn(filed(), sweeping({ flag: 'flagged' }))).toEqual(['conv-1']);
  });

  it('a message given a category, another importance or another folder writes its thread again too', async () => {
    expect(await runOn(filed(), sweeping({ categories: ['Blue category'] }))).toEqual(['conv-1']);
    expect(await runOn(filed(), sweeping({ importance: 'high' }))).toEqual(['conv-1']);
    expect(await runOn(filed(), sweeping({ folderId: 'AAMk-follow' }))).toEqual(['conv-1']);
  });

  it('a message that gained a reply and was flagged as well is counted and queued once', async () => {
    const reader = sweeping({ flag: 'flagged' });
    const reply = message({ id: 'm2', received: '2026-05-13T10:00:00Z', folderId: 'AAMk-inbox', flag: 'notFlagged', importance: 'normal', categories: [] });
    const { asked, logger } = await run({
      files: { texts: { [STATE_PATH]: serializeMailboxState(filed()) } },
      reader: { ...reader, pages: [{ messages: [...(reader.pages?.[0]?.messages ?? []), reply], skipped: 0, deltaLink: 'c1' }] },
    });

    expect(asked).toEqual(['conv-1']);
    expect(logger.calls).toContainEqual({ level: 'info', event: 'mail.enumerated', meta: { messages: 2, conversations: 1, queued: 1 } });
  });

  it('a message only read since leaves its thread alone', async () => {
    expect(await runOn(filed(), sweeping())).toStrictEqual([]);
  });

  // The day narrows which conversations come in, not what happens to one already in.
  it('a message flagged from before the day asked for still writes its thread again, the thread being in the knowledge base', async () => {
    expect(await runOn(filed(), sweeping({ flag: 'flagged' }), '2026-06-01')).toEqual(['conv-1']);
  });

  // Graph gives a message a new id when it moves to another folder, so a move reads as a message the
  // thread never held. A thread already in the knowledge base is written again for it, whatever its day.
  it('a message from before the day asked for that moved, and so came back under a new id, writes its recorded thread again', async () => {
    const moved = sweeping({ id: 'm1-moved', folderId: 'AAMk-follow' });

    expect(await runOn(filed(), moved, '2026-06-01')).toEqual(['conv-1']);
  });

  it('a conversation from before the day asked for that no thread holds is still left out', async () => {
    // Resolved to a thread that was never written, which is no thread in the knowledge base either.
    const unwritten = withConversation(filed(), 'conv-9', { threadId: 'thread-9', root: '<nine@example.com>' });

    expect(await runOn(filed(), sweeping({ id: 'm9', conversationId: 'conv-9' }), '2026-06-01')).toStrictEqual([]);
    expect(await runOn(unwritten, sweeping({ id: 'm9', conversationId: 'conv-9' }), '2026-06-01')).toStrictEqual([]);
  });

  it('a thread written before its messages were recorded is written again only for a new message', async () => {
    expect(await runOn(filedWith(undefined), sweeping({ flag: 'flagged' }))).toStrictEqual([]);
  });
});

// A cursor keeps the fields of the request that opened it, so one taken before decant read a
// message's folder and flag goes on reading without them; and a thread written then holds no record of
// its messages. Both are made good once, on the first sweep that finds the state from before.
describe('updating a mailbox written before the message fields were read', () => {
  const filed = withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<root@example.com>' }), 'thread-1', {
    folder: '2026-05-12-thread-1',
    conversationIds: ['conv-1'],
    file: 'threads/2026-05-12-thread-1/contrat-contoso.md',
    messageIds: ['m1'],
    lastMessage: '2026-05-12T09:31:00Z',
    attachments: [],
    inlineImages: [],
    subject: 'RE: Contrat Contoso',
  });
  const before = (state: MailboxState): string => serializeMailboxState({ ...withFolderCursor(state, 'AAMk-inbox', 'Inbox', 'cursor-1'), fields: undefined });
  const quiet = { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'cursor-2' }] };

  it('reads every folder from the start and writes every thread again, once', async () => {
    const { reader, asked, labels, files, logger } = await run({ files: { texts: { [STATE_PATH]: before(filed) } }, reader: quiet });

    expect(reader.calls).toContain('folderDelta:AAMk-inbox');
    expect(reader.calls).not.toContain('deltaFrom:cursor-1');
    expect(asked).toEqual(['conv-1']);
    expect(labels).toEqual(['Contrat Contoso']);
    expect(stateAfter(files)).toMatchObject({ fields: 2, folders: { 'AAMk-inbox': { deltaLink: 'cursor-2' } } });
    expect(logger.calls).toContainEqual({ level: 'info', event: 'mail.fields-upgraded', meta: { threads: 1 } });

    const next = await run({ files: { texts: { [STATE_PATH]: files.written.get(STATE_PATH) ?? '' } }, reader: quiet });

    expect(next.asked).toStrictEqual([]);
    expect(next.reader.calls).toContain('deltaFrom:cursor-2');
  });

  // In the order of their keys, so the queue a stopped update leaves is the same whatever order the
  // state was read in; and a thread written before subjects were kept is named for what it is.
  it('queues the threads in the order of their ids, naming one with no subject as from an earlier run', async () => {
    const second = withThread(withConversation(filed, 'conv-0', { threadId: 'thread-0', root: '<zero@example.com>' }), 'thread-0', {
      ...filed.threads['thread-1'],
      folder: '2026-05-11-thread-0',
      conversationIds: ['conv-0'],
      file: 'threads/2026-05-11-thread-0/x.md',
      messageIds: ['m0'],
      lastMessage: '2026-05-11T09:31:00Z',
      attachments: [],
      inlineImages: [],
      subject: undefined,
    });
    const { asked, labels } = await run({ files: { texts: { [STATE_PATH]: before(second) } }, reader: quiet });

    expect(asked).toEqual(['conv-0', 'conv-1']);
    expect(labels).toEqual(['a conversation from an earlier run', 'Contrat Contoso']);
  });

  it('leaves alone a thread that has run out of tries', async () => {
    const { asked } = await run({ files: { texts: { [STATE_PATH]: before(withRetry(filed, 'thread-1', { attempts: 3, reason: 'refused' })) } }, reader: quiet });

    expect(asked).toStrictEqual([]);
  });

  it('a dry run counts the threads the update will write, and writes nothing', async () => {
    const { summary, files } = await run({ files: { texts: { [STATE_PATH]: before(filed) } }, reader: quiet, dryRun: true });

    expect(summary.queued).toBe(1);
    expect(files.writeLog).toStrictEqual([]);
  });

  // The queue a stopped run left is written first; the sweep that would update comes on the next run.
  it('a run that continues a saved queue leaves the update to the next sweep', async () => {
    const halfDone = serializeMailboxState({ ...filed, fields: undefined, pending: ['thread-1'] });
    const { reader, files } = await run({ files: { texts: { [STATE_PATH]: halfDone } }, reader: quiet });

    expect(reader.calls.some((call) => call.startsWith('folderDelta') || call.startsWith('deltaFrom'))).toBe(false);
    expect(stateAfter(files)).not.toHaveProperty('fields');
  });
});

describe('naming the folder each message sits in', () => {
  it('the folders the sweep passes over are named for the messages a thread holds in them', async () => {
    const reader = { folders: [folder(), folder({ id: 'AAMk-bin', name: 'Deleted Items' })], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] };
    const { files, inputs } = await run({ reader });

    expect(JSON.parse(files.written.get(STATE_PATH) ?? '{}').unsweptFolders).toEqual({ 'AAMk-bin': 'Deleted Items' });
    expect(inputs[0]?.folders).toEqual({ 'AAMk-bin': 'Deleted Items', 'AAMk-inbox': 'Inbox' });
  });

  // A run that resumes a queue lists no folders, so the names come from what the last sweep kept.
  it('a run that resumes its queue names the folders the last sweep listed', async () => {
    const held = withConversation(emptyMailboxState(), 'conv-9', { threadId: 'thread-9', root: '<r@example.com>' });
    const halfDone = serializeMailboxState({
      ...withFolderCursor(held, 'AAMk-inbox', 'Inbox', 'c1'),
      unsweptFolders: { 'AAMk-bin': 'Deleted Items' },
      pending: ['thread-9'],
    });
    const { inputs } = await run({ files: { texts: { [STATE_PATH]: halfDone } }, reader: { folders: [folder()] } });

    expect(inputs[0]?.folders).toEqual({ 'AAMk-bin': 'Deleted Items', 'AAMk-inbox': 'Inbox' });
  });

  describe('a folder renamed at the source', () => {
    const inFollow = withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<root@example.com>' }), 'thread-1', {
      folder: '2026-05-12-thread-1',
      conversationIds: ['conv-1'],
      file: 'threads/2026-05-12-thread-1/contrat-contoso.md',
      messageIds: ['m1'],
      lastMessage: '2026-05-12T09:31:00Z',
      attachments: [],
      inlineImages: [],
      subject: 'RE: Contrat Contoso',
      messages: [
        {
          id: 'm1',
          received: '2026-05-12T09:31:00Z',
          subject: 'Contrat Contoso',
          to: [],
          cc: [],
          folderId: 'AAMk-follow',
          flag: 'notFlagged',
          importance: 'normal',
          categories: [],
          folder: 'Follow',
          draft: false,
          internetMessageId: '',
          preview: '',
          attachments: [],
          linked: [],
        },
      ],
    });
    const renamed = { folders: [folder({ id: 'AAMk-follow', name: 'To_Follow' })], pages: [{ messages: [], skipped: 0, deltaLink: 'c1' }] };
    const before = (state: MailboxState): string => serializeMailboxState(withFolderCursor(state, 'AAMk-follow', 'Follow', 'c0'));

    // No message changed, so no delta reports one, and only the name tells the run.
    it('writes again each thread with a message in it, under the subject it was written with', async () => {
      const { asked, labels } = await run({ files: { texts: { [STATE_PATH]: before(inFollow) } }, reader: renamed });

      expect(asked).toEqual(['conv-1']);
      expect(labels).toEqual(['Contrat Contoso']);
    });

    it('leaves alone a thread that has run out of tries', async () => {
      const { asked } = await run({ files: { texts: { [STATE_PATH]: before(withRetry(inFollow, 'thread-1', { attempts: 3, reason: 'refused' })) } }, reader: renamed });

      expect(asked).toStrictEqual([]);
    });

    it('a folder that keeps its name writes nothing again', async () => {
      const kept = { ...renamed, folders: [folder({ id: 'AAMk-follow', name: 'Follow' })] };
      const { asked } = await run({ files: { texts: { [STATE_PATH]: before(inFollow) } }, reader: kept });

      expect(asked).toStrictEqual([]);
    });
  });
});

describe('narrowing a mailbox sync to recent mail', () => {
  it('conversations older than the day asked for are left out', async () => {
    const messages = [
      message({ id: 'old', conversationId: 'conv-old', received: '2024-01-01T00:00:00Z' }),
      message({ id: 'new', conversationId: 'conv-new', received: '2026-05-12T09:31:00Z' }),
    ];
    const { asked } = await run({ reader: { folders: [folder()], pages: [{ messages, skipped: 0, deltaLink: 'c1' }] }, since: '2026-01-01' });

    expect(asked).toEqual(['conv-new']);
  });

  // A cursor reports only what changed after it, so a day moved earlier would otherwise never see
  // the conversations the narrower sweep passed over.
  it('a day moved earlier than the one the cursors were taken under sweeps every folder from the start, and writes only what it had left out', async () => {
    const held = withConversation(emptyMailboxState(), 'conv-new', { threadId: 'thread-new', root: '<new@example.com>' });
    const filed = withThread(held, 'thread-new', {
      folder: '2026-05-12-thread-new',
      conversationIds: ['conv-new'],
      file: 'threads/2026-05-12-thread-new/x.md',
      messageIds: ['new'],
      lastMessage: '2026-05-12T09:31:00Z',
      attachments: [],
      inlineImages: [],
    });
    const known = serializeMailboxState({ ...filed, since: '2026-01-01', folders: { 'AAMk-inbox': { name: 'Inbox', deltaLink: 'cursor-1' } } });
    const messages = [
      message({ id: 'old', conversationId: 'conv-old', received: '2025-03-01T00:00:00Z' }),
      message({ id: 'new', conversationId: 'conv-new', received: '2026-05-12T09:31:00Z' }),
    ];

    const { reader, asked, files, logger } = await run({
      files: { texts: { [STATE_PATH]: known } },
      reader: { folders: [folder()], pages: [{ messages, skipped: 0, deltaLink: 'cursor-2' }] },
      since: '2025-01-01',
    });

    expect(reader.calls).toContain('folderDelta:AAMk-inbox');
    expect(reader.calls).not.toContain('deltaFrom:cursor-1');
    expect(asked).toEqual(['conv-old']);
    expect(JSON.parse(files.written.get(STATE_PATH) ?? '{}')).toMatchObject({ since: '2025-01-01', folders: { 'AAMk-inbox': { deltaLink: 'cursor-2' } } });
    expect(logger.calls).toContainEqual({ level: 'info', event: 'mail.widened', meta: { from: '2026-01-01', to: '2025-01-01' } });
  });

  it('the same day, or a later one, keeps following the cursors; all widens them, and keeps no day', async () => {
    const texts = { [STATE_PATH]: serializeMailboxState({ ...emptyMailboxState(), since: '2026-01-01', folders: { 'AAMk-inbox': { name: 'Inbox', deltaLink: 'cursor-1' } } }) };

    for (const since of ['2026-01-01', '2026-03-01']) {
      const kept = await run({ files: { texts }, reader: { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'cursor-2' }] }, since });

      expect(kept.reader.calls).toContain('deltaFrom:cursor-1');
      expect(JSON.parse(kept.files.written.get(STATE_PATH) ?? '{}')).toMatchObject({ since });
    }

    const everything = await run({ files: { texts }, reader: { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'cursor-2' }] } });

    expect(everything.reader.calls).toContain('folderDelta:AAMk-inbox');
    expect('since' in JSON.parse(everything.files.written.get(STATE_PATH) ?? '{}')).toBe(false);
    expect(everything.logger.calls).toContainEqual({ level: 'info', event: 'mail.widened', meta: { from: '2026-01-01', to: 'all' } });
  });

  it('without a day asked for, everything the sweep returned is written', async () => {
    const messages = [message({ id: 'old', conversationId: 'conv-old', received: '2024-01-01T00:00:00Z' })];
    const { asked } = await run({ reader: { folders: [folder()], pages: [{ messages, skipped: 0, deltaLink: 'c1' }] } });

    expect(asked).toEqual(['conv-old']);
  });
});

describe('a message removed at the source', () => {
  const held = withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<r@example.com>' });
  const filed = serializeMailboxState(
    withFolderCursor(
      withThread(held, 'thread-1', {
        folder: '2026-05-12-thread-1-contrat',
        conversationIds: ['conv-1'],
        file: 'threads/2026-05-12-thread-1-contrat/contrat.md',
        messageIds: ['m0', 'm1'],
        lastMessage: '2026-05-12T09:31:00Z',
        attachments: [],
        inlineImages: [],
        subject: 'Contrat Contoso',
      }),
      'AAMk-inbox',
      'Inbox',
      'cursor-1'
    )
  );
  // What Graph sends for a message deleted, or moved out of the folder: its id and nothing else.
  const removed = (id: string): MailMessage => message({ id, conversationId: '', isDeleted: true });

  // A delta names a removed message by its id alone, with no conversation, so the thread is found by
  // the ids it holds. Written again, it shows what the mailbox holds now.
  it('writes again the thread that held it, named as it was written', async () => {
    const { asked, labels } = await run({
      files: { texts: { [STATE_PATH]: filed } },
      reader: { folders: [folder()], pages: [{ messages: [removed('m0')], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(asked).toEqual(['conv-1']);
    expect(labels).toEqual(['Contrat Contoso']);
  });

  it('a removed message no thread held writes nothing', async () => {
    const { asked } = await run({
      files: { texts: { [STATE_PATH]: filed } },
      reader: { folders: [folder()], pages: [{ messages: [removed('m9')], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(asked).toStrictEqual([]);
  });
});

describe('the files a thread written again no longer holds', () => {
  const FOLDER = '2026-05-12-thread-1-contrat';
  const HERE = `kb/Mailbox/threads/${FOLDER}`;
  const A = `${HERE}/_attachments/a.pdf.md`;
  const B = `${HERE}/_attachments/b.pdf.md`;
  const record = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
    folder: FOLDER,
    conversationIds: ['conv-1'],
    file: `threads/${FOLDER}/contrat.md`,
    messageIds: ['m0'],
    lastMessage: '2026-05-12T09:31:00Z',
    attachments: [],
    inlineImages: [],
    ...over,
  });
  const held = (thread: ThreadRecord, over: Partial<MailboxState> = {}): string =>
    serializeMailboxState({ ...withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<r@example.com>' }), 'thread-1', thread), ...over });
  // A new message in the thread is what sends it to be written again.
  const pages = [{ messages: [message()], skipped: 0, deltaLink: 'c1' }];
  const writing = (files: ReadonlyArray<string>): RenderThreadOutcome => ({
    kind: 'rendered',
    thread: { record: record({ messageIds: ['m0', 'm1'], files }), linked: {}, attachments: {}, filesSkipped: [], filesFailed: [] },
  });

  // Moved, not deleted: the thread no longer holds the file, and the kb keeps the old version.
  it('a file the thread no longer holds goes under the archive and is named in the report', async () => {
    const { files, summary, notes } = await run({
      files: { texts: { [STATE_PATH]: held(record({ files: [A, B] })), [A]: 'a', [B]: 'b' } },
      reader: { folders: [folder()], pages },
      outcome: () => writing([A]),
    });

    expect(files.moves).toEqual([{ from: B, to: `kb/_archive/2026-07-23/Mailbox/threads/${FOLDER}/_attachments/b.pdf.md` }]);
    expect(summary).toMatchObject({ converted: 1, archived: 1 });
    expect(notes?.archived).toEqual([{ path: `threads/${FOLDER}/_attachments/b.pdf.md`, reason: 'no longer in the thread' }]);
    expect(files.written.get('kb/Mailbox/_sync-report.md')).toContain(`- threads/${FOLDER}/_attachments/b.pdf.md: no longer in the thread`);
  });

  it('a thread written before its files were listed goes by its attachments', async () => {
    const { files } = await run({
      files: { texts: { [STATE_PATH]: held(record({ attachments: [A, B] })), [A]: 'a', [B]: 'b' } },
      reader: { folders: [folder()], pages },
      outcome: () => writing([A]),
    });

    expect(files.moves.map((move) => move.from)).toEqual([B]);
  });

  // A state written under another root, before the knowledge base moved, names its files there.
  it('a file listed under another root is put aside and named by its whole path', async () => {
    const elsewhere = `old/Mailbox/threads/${FOLDER}/_attachments/c.pdf.md`;
    const { notes } = await run({
      files: { texts: { [STATE_PATH]: held(record({ files: [A, elsewhere] })), [A]: 'a', [elsewhere]: 'c' } },
      reader: { folders: [folder()], pages },
      outcome: () => writing([A]),
    });

    expect(notes?.archived).toEqual([{ path: elsewhere, reason: 'no longer in the thread' }]);
  });

  it('a thread that could not be written puts nothing aside and names nothing as moved', async () => {
    const { files, notes } = await run({
      files: { texts: { [STATE_PATH]: held(record({ files: [A, B] })), [A]: 'a', [B]: 'b' } },
      reader: { folders: [folder()], pages },
      failThread: 'conv-1',
    });

    expect(files.moves).toStrictEqual([]);
    expect(notes?.archived).toStrictEqual([]);
  });

  // Nothing is there to keep, so nothing is reported.
  it('a file listed but not on disk is passed over without a word', async () => {
    const { files, summary, notes } = await run({
      files: { texts: { [STATE_PATH]: held(record({ files: [A, B] })), [A]: 'a' } },
      reader: { folders: [folder()], pages },
      outcome: () => writing([A]),
    });

    expect(files.moves).toStrictEqual([]);
    expect(summary.archived).toBe(0);
    expect(notes?.archived).toStrictEqual([]);
  });

  // A record left behind would hand a later message carrying the same file a path that is no longer
  // there, and the indexes would list it.
  it('the stored records of a file put aside leave the state', async () => {
    const stored = { name: 'b.pdf', paths: [B], primary: B, media: [] };
    const { files } = await run({
      files: { texts: { [STATE_PATH]: held(record({ files: [A, B] }), { attachments: { hash: stored }, linked: { 'b!one:01ABC': { paths: [B] } } }), [A]: 'a', [B]: 'b' } },
      reader: { folders: [folder()], pages },
      outcome: () => writing([A]),
    });

    expect(stateAfter(files).attachments).toEqual({});
    expect(stateAfter(files).linked).toEqual({});
  });

  // What a write could not read may be a file the thread still holds: a throttled download looks the
  // same as a file of a message gone. The next write that reads everything decides.
  it('a write that could not read every file puts nothing aside, and the next write that reads everything does', async () => {
    const failing = (): RenderThreadOutcome => {
      const written = writing([A]);
      return written.kind === 'rendered' ? { ...written, thread: { ...written.thread, filesFailed: [{ path: 'b.pdf', reason: 'throttled: slow down' }] } } : written;
    };
    const first = await run({
      files: { texts: { [STATE_PATH]: held(record({ files: [A, B] })), [A]: 'a', [B]: 'b' } },
      reader: { folders: [folder()], pages },
      outcome: failing,
    });
    const kept = stateAfter(first.files);

    expect(first.files.moves).toStrictEqual([]);
    expect(first.summary.archived).toBe(0);
    expect((kept.threads['thread-1'] as ThreadRecord | undefined)?.files).toEqual([A, B]);

    const second = await run({
      files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '', [A]: 'a', [B]: 'b' } },
      reader: { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'c2' }] },
      outcome: () => writing([A]),
    });

    expect(second.files.moves.map((move) => move.from)).toEqual([B]);
  });

  // Still on disk, so still the thread's: listed in its record, its stored record kept, and its name
  // held, so no later file of that name writes over it before a run moves it aside.
  it('a file that will not move is logged by its thread, and stays in the record and the store', async () => {
    const stored = { name: 'b.pdf', paths: [B], primary: B, media: [] };
    const { summary, logger, files } = await run({
      files: {
        texts: { [STATE_PATH]: held(record({ files: [A, B] }), { attachments: { hash: stored } }), [A]: 'a', [B]: 'b' },
        failMoveWith: { kind: 'write-failed', path: B, message: 'locked' },
      },
      reader: { folders: [folder()], pages },
      outcome: () => writing([A]),
    });

    expect(logger.calls).toContainEqual({ level: 'warn', event: 'archive.failed', meta: { threadId: 'thread-1', cause: 'write-failed' } });
    expect(summary).toMatchObject({ converted: 1, archived: 0 });
    expect(files.written.get(B)).toBe('b');
    expect((stateAfter(files).threads['thread-1'] as ThreadRecord | undefined)?.files).toEqual([A, B]);
    expect(stateAfter(files).attachments).toEqual({ hash: stored });
  });
});

describe('a thread with no message left at the source', () => {
  const FOLDER = '2026-05-12-thread-1-contrat';
  const NOTE = `kb/Mailbox/threads/${FOLDER}/contrat.md`;
  const CARD = `kb/Mailbox/threads/${FOLDER}/_attachments/a.pdf.md`;
  const state = (): MailboxState => {
    const fed = withConversation(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<r@example.com>' }), 'conv-2', {
      threadId: 'thread-1',
      root: '<r@example.com>',
    });
    const other = withThread(withConversation(fed, 'conv-3', { threadId: 'thread-3', root: '<s@example.com>' }), 'thread-3', {
      folder: '2026-05-10-thread-3-other',
      conversationIds: ['conv-3'],
      file: 'threads/2026-05-10-thread-3-other/other.md',
      messageIds: ['m3'],
      lastMessage: '2026-05-10T09:31:00Z',
      attachments: [],
      inlineImages: [],
    });
    const filed = withThread(other, 'thread-1', {
      folder: FOLDER,
      conversationIds: ['conv-1', 'conv-2'],
      file: `threads/${FOLDER}/contrat.md`,
      messageIds: ['m0'],
      lastMessage: '2026-05-12T09:31:00Z',
      attachments: [],
      inlineImages: [],
      files: [CARD],
    });
    return withRetry(filed, 'thread-1', { attempts: 1, reason: 'a.pdf: locked' });
  };
  const gone = [{ messages: [message({ id: 'm0', conversationId: '', isDeleted: true })], skipped: 0, deltaLink: 'c1' }];

  // The note and its files are kept under the archive, and the thread leaves the state: nothing at the
  // source is left to write it from.
  it('goes under the archive whole, is named in the report, and leaves the state', async () => {
    const { files, summary, notes } = await run({
      files: { texts: { [STATE_PATH]: serializeMailboxState(state()), [NOTE]: 'note', [CARD]: 'card' } },
      reader: { folders: [folder()], pages: gone },
      outcome: () => ({ kind: 'empty' }),
    });
    const after = stateAfter(files);

    expect(files.moves).toEqual([
      { from: NOTE, to: `kb/_archive/2026-07-23/Mailbox/threads/${FOLDER}/contrat.md` },
      { from: CARD, to: `kb/_archive/2026-07-23/Mailbox/threads/${FOLDER}/_attachments/a.pdf.md` },
    ]);
    expect(summary).toMatchObject({ converted: 0, archived: 1, skipped: 0 });
    expect(notes?.archived).toEqual([{ path: `threads/${FOLDER}/contrat.md`, reason: 'no message left at the source' }]);
    expect(Object.keys(after.threads)).toEqual(['thread-3']);
    expect(after.conversations).toEqual({ 'conv-3': { threadId: 'thread-3', root: '<s@example.com>' } });
    expect(after.retry).toEqual({});
  });

  // Left where it is, the note still reads as current, so the thread keeps its record and is tried
  // again on the next run, three times in all.
  it('a thread whose note will not move keeps its record and is tried again', async () => {
    const { files, summary, notes } = await run({
      files: { texts: { [STATE_PATH]: serializeMailboxState(state()), [NOTE]: 'note', [CARD]: 'card' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'locked' } },
      reader: { folders: [folder()], pages: gone },
      outcome: () => ({ kind: 'empty' }),
    });
    const after = stateAfter(files);

    expect(summary).toMatchObject({ archived: 0, failed: 1 });
    expect(notes?.failed).toEqual([{ path: `threads/${FOLDER}/contrat.md`, reason: 'could not be moved aside: write-failed' }]);
    expect(after.threads['thread-1']).toMatchObject({ folder: FOLDER, file: `threads/${FOLDER}/contrat.md` });
    // The sweep queued the thread for itself, so the count of an earlier failure starts over.
    expect(after.retry['thread-1']).toEqual({ attempts: 1, reason: 'could not be moved aside: write-failed' });
  });
});

describe('what the mailbox sync reports', () => {
  it('a conversation whose messages have all gone is counted as skipped', async () => {
    const { summary } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome: () => ({ kind: 'empty' }) });

    expect(summary).toMatchObject({ converted: 0, skipped: 1 });
  });

  it('attachments left out or refused are counted alongside the conversation', async () => {
    const outcome = (): RenderThreadOutcome =>
      rendered({
        thread: {
          record: { folder: '2026-05-12-a3f9c1e0d2-thread', conversationIds: ['conv-1'], file: 'f.md', messageIds: ['m1'], lastMessage: 'x', attachments: [], inlineImages: [] },
          linked: {},
          attachments: {},
          filesSkipped: [
            { path: 'a.mp4', reason: 'a .mp4 file, which this tool does not read' },
            { path: 'b.mov', reason: 'a .mov file, which this tool does not read' },
          ],
          filesFailed: [{ path: 'c.docx', reason: 'locked' }],
        },
      });
    const { summary } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome });

    expect(summary).toMatchObject({ converted: 1, skipped: 2, failed: 1 });
  });

  it('a conversation that could not be written is counted, and the ones after it still land', async () => {
    const messages = [message({ id: 'a', conversationId: 'conv-a' }), message({ id: 'b', conversationId: 'conv-b', received: '2026-05-13T00:00:00Z' })];
    const { summary, asked, logger } = await run({ reader: { folders: [folder()], pages: [{ messages, skipped: 0, deltaLink: 'c1' }] }, failThread: 'conv-a' });

    expect(asked).toEqual(['conv-a', 'conv-b']);
    expect(summary).toMatchObject({ converted: 1, failed: 1 });
    expect(logger.calls.some((call) => call.event === 'thread.failed')).toBe(true);
  });

  it('a dry run reports what it would write and writes nothing at all', async () => {
    const { summary, files } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, dryRun: true });

    expect(summary.queued).toBe(1);
    expect(files.written.size).toBe(0);
  });

  it('the files pulled for one conversation are remembered for the next one', async () => {
    const outcome = (): RenderThreadOutcome =>
      rendered({
        thread: {
          record: { folder: '2026-05-12-a3f9c1e0d2-thread', conversationIds: ['conv-1'], file: 'f.md', messageIds: ['m1'], lastMessage: 'x', attachments: [], inlineImages: [] },
          linked: { 'b!one:01ABC': { paths: ['kb/Mailbox/_linked/R.docx.md'] } },
          attachments: {},
          filesSkipped: [],
          filesFailed: [],
        },
      });
    const { files } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome });

    expect(stateAfter(files).linked['b!one:01ABC']).toEqual({ paths: ['kb/Mailbox/_linked/R.docx.md'] });
  });

  it('the attachments one conversation stored are remembered, so the next conversation dedupes against them', async () => {
    const outcome = (): RenderThreadOutcome =>
      rendered({
        thread: {
          record: { folder: '2026-05-12-a3f9c1e0d2-thread', conversationIds: ['conv-1'], file: 'f.md', messageIds: ['m1'], lastMessage: 'x', attachments: [], inlineImages: [] },
          linked: {},
          attachments: {
            ba7816bf8f01: { name: 'Contrat.docx', paths: ['kb/Mailbox/_attachments/Contrat.docx.md'], primary: 'kb/Mailbox/_attachments/Contrat.docx.md', media: [] },
          },
          filesSkipped: [],
          filesFailed: [],
        },
      });
    const { files } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome });

    expect(stateAfter(files).attachments['ba7816bf8f01']).toEqual({
      name: 'Contrat.docx',
      paths: ['kb/Mailbox/_attachments/Contrat.docx.md'],
      primary: 'kb/Mailbox/_attachments/Contrat.docx.md',
      media: [],
    });
  });
});

describe('reporting what did not reach the knowledge base', () => {
  const REPORT_PATH = 'kb/Mailbox/_sync-report.md';

  it('an attachment left out is named in the report with the reason', async () => {
    const outcome = (): RenderThreadOutcome =>
      rendered({
        thread: {
          record: { folder: '2026-05-12-a3f9c1e0d2-thread', conversationIds: ['conv-1'], file: 'f.md', messageIds: ['m1'], lastMessage: 'x', attachments: [], inlineImages: [] },
          linked: {},
          attachments: {},
          filesSkipped: [{ path: 'Demo.mp4', reason: 'a .mp4 file, which this tool does not read' }],
          filesFailed: [{ path: 'Contrat.docx', reason: 'permanent: cannot convert' }],
        },
      });
    const { files } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome });
    const report = files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('# What did not reach the knowledge base: Mailbox');
    expect(report).toContain('- Demo.mp4: a .mp4 file, which this tool does not read');
    expect(report).toContain('- Contrat.docx: permanent: cannot convert');
  });

  it('a conversation that could not be written is named in the report by its subject', async () => {
    const { files, logger } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, failThread: 'conv-1' });

    expect(files.written.get(REPORT_PATH)).toContain('- thread Contrat Contoso: thread refused');
    expect(logger.calls.filter((call) => call.event === 'thread.failed')).toEqual([{ level: 'warn', event: 'thread.failed', meta: { cause: 'permanent' } }]);
  });

  it('a run where every conversation converted cleanly writes no report', async () => {
    const { files } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] } });

    expect(files.written.has(REPORT_PATH)).toBe(false);
  });
});

describe('when the mailbox or the disk refuses', () => {
  it('a mailbox that cannot be listed ends the run with the reason', async () => {
    const { ok: succeeded } = await run({ reader: { failWith: { kind: 'auth', message: 'not authenticated' } } });

    expect(succeeded).toBe(false);
  });

  it('a folder whose sweep fails ends the run rather than storing a cursor past the gap', async () => {
    const { ok: succeeded } = await run({ reader: { folders: [folder()], failWith: { kind: 'throttled', message: 'too many requests' } } });

    expect(succeeded).toBe(false);
  });

  it('a knowledge base that cannot be written to ends the run, naming the step that failed', async () => {
    const { ok: succeeded, error } = await run({
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
      files: { failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } },
    });

    expect(succeeded).toBe(false);
    expect(error).toEqual({ step: 'saveMailState', cause: 'write-failed', message: 'disk full' });
  });

  it('a mailbox that cannot be listed names the step and the reason', async () => {
    const { error } = await run({ reader: { failWith: { kind: 'auth', message: 'not authenticated' } } });

    expect(error).toEqual({ step: 'listFolders', cause: 'auth', message: 'not authenticated' });
  });

  it('a folder whose sweep fails names the step and the reason', async () => {
    const { error } = await run({ reader: { folders: [folder()], failCalls: { folderDelta: { kind: 'throttled', message: 'too many requests' } } } });

    expect(error).toEqual({ step: 'sweepFolder', cause: 'throttled', message: 'too many requests' });
  });

  it('a folder whose nested folders cannot be listed ends the run rather than skipping them', async () => {
    const { ok: succeeded } = await run({
      reader: { folders: [folder({ childCount: 2 })], children: {}, failCalls: { listChildFolders: { kind: 'transient', message: 'timeout' } } },
    });

    expect(succeeded).toBe(false);
  });

  it('a state file that cannot be read is synced from scratch rather than refused', async () => {
    const { summary, logger } = await run({
      files: { texts: { [STATE_PATH]: 'not json' } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
    });

    expect(summary.converted).toBe(1);
    expect(logger.calls.some((call) => call.event === 'mail-state.unusable')).toBe(true);
  });
});

describe('rendering several conversations at once', () => {
  const threeConversations: MailReaderSeed = {
    folders: [folder()],
    pages: [
      {
        messages: [
          message({ id: 'a', conversationId: 'conv-a', subject: 'Offsite planning' }),
          message({ id: 'b', conversationId: 'conv-b', subject: 'RE: Budget review', received: '2026-05-13T00:00:00Z' }),
          message({ id: 'c', conversationId: 'conv-c', subject: 'Fwd: Venue quotes', received: '2026-05-14T00:00:00Z' }),
        ],
        skipped: 0,
        deltaLink: 'c1',
      },
    ],
  };

  it('a window renders every conversation and records them all', async () => {
    const { summary, asked } = await run({ reader: threeConversations, concurrency: 3 });

    expect(summary.converted).toBe(3);
    expect([...asked].sort((left, right) => left.localeCompare(right))).toEqual(['conv-a', 'conv-b', 'conv-c']);
  });

  it('each counter shows its total up front: the folders read, the conversations new to the mailbox, then the ones written', async () => {
    const { progress } = await run({ reader: threeConversations, concurrency: 3 });

    expect(progress.started).toEqual([
      { total: 1, what: 'Mailbox, reading folders' },
      { total: 3, what: 'Mailbox, new conversations' },
      { total: 3, what: 'Mailbox' },
    ]);
    expect(progress.steps).toHaveLength(1 + 3 + 3);
    expect(progress.dones).toHaveLength(3);
  });

  it('each conversation new to the mailbox is counted by its subject while its thread is found, and one already known is not', async () => {
    const known = serializeMailboxState(withConversation(emptyMailboxState(), 'conv-a', { threadId: threadIdOf('a'), root: 'a' }));

    const { progress } = await run({ files: { texts: { [STATE_PATH]: known } }, reader: threeConversations, concurrency: 3 });

    expect(progress.started[1]).toEqual({ total: 2, what: 'Mailbox, new conversations' });
    expect(progress.begins.slice(1, 3)).toEqual(['Budget review', 'Venue quotes']);
  });

  it('each conversation is rendered under the name its row goes by, so what it reads shows beside it', async () => {
    const { labels } = await run({ reader: threeConversations, concurrency: 3 });

    expect(labels).toEqual(['Offsite planning', 'Budget review', 'Venue quotes']);
  });

  it('every conversation in the window announces itself by its subject before any of them finish', async () => {
    const { progress } = await run({ reader: threeConversations, concurrency: 3 });

    // The last three are the window's: the folder and the new conversations were counted before it.
    expect(progress.begins.slice(-3).sort((left, right) => left.localeCompare(right))).toEqual(['Budget review', 'Offsite planning', 'Venue quotes']);
  });

  // The subject is kept beside the queue, so a run that resumes it names the conversation the way the
  // run that queued it did. A queue from before subjects were kept has none, and says so in words.
  it('a conversation queued by an earlier run is named by the subject kept for it, or as one from an earlier run', async () => {
    const held = withConversation(emptyMailboxState(), 'conv-9', { threadId: 'thread-9', root: '<r@example.com>' });
    const titled = serializeMailboxState({ ...held, pending: ['thread-9'], titles: { 'thread-9': 'Budget review' } });
    const untitled = serializeMailboxState({ ...held, pending: ['thread-9'] });

    const resumed = await run({ files: { texts: { [STATE_PATH]: titled } }, reader: { folders: [folder()] } });
    const older = await run({ files: { texts: { [STATE_PATH]: untitled } }, reader: { folders: [folder()] } });

    expect(resumed.progress.begins).toEqual(['Budget review']);
    expect(older.progress.begins).toEqual(['a conversation from an earlier run']);
  });

  it('a conversation tried again is named by the subject kept for it, though no message of it was swept', async () => {
    const held = withConversation(emptyMailboxState(), 'conv-9', { threadId: 'thread-9', root: '<r@example.com>' });
    const owed = serializeMailboxState({ ...held, retry: { 'thread-9': { attempts: 1, reason: 'thread refused' } }, titles: { 'thread-9': 'Budget review' } });

    const { progress } = await run({ files: { texts: { [STATE_PATH]: owed } }, reader: { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'c1' }] } });

    expect(progress.begins).toEqual(['Inbox', 'Budget review']);
  });

  it('a subject is kept while its conversation is owed another try, and dropped once it is written', async () => {
    const { files } = await run({ reader: threeConversations, concurrency: 3, failThread: 'conv-b' });

    expect(JSON.parse(files.written.get(STATE_PATH) ?? '{}').titles).toEqual({ [threadIdOf('b')]: 'Budget review' });
  });

  it('a conversation with no subject is said to have none', async () => {
    const { progress } = await run({ reader: { folders: [folder()], pages: [{ messages: [message({ subject: '' })], skipped: 0, deltaLink: 'c1' }] } });

    // Once while its thread is found, once while it is written.
    expect(progress.begins).toEqual(['Inbox', '(no subject)', '(no subject)']);
  });

  // The case the whole identity scheme exists for. Graph opens a second conversation for one
  // exchange when an external party replies from outside Exchange; both resolve to the same root,
  // so they are one thread and are rendered once, together. Rendering them apart would have each
  // write the shared document holding only its own half, and the loser would be gone for good.
  it('two conversations sharing a root are rendered as one thread, once', async () => {
    const root = [{ name: 'References', value: '<shared@example.com>' }];
    const reader: MailReaderSeed = {
      folders: [folder()],
      pages: [
        {
          messages: [message({ id: 'a', conversationId: 'conv-a' }), message({ id: 'b', conversationId: 'conv-b', received: '2026-05-13T00:00:00Z' })],
          skipped: 0,
          deltaLink: 'c1',
        },
      ],
      headers: { a: root, b: root },
    };
    const { asked, files } = await run({ reader, concurrency: 2 });

    expect(asked).toEqual(['conv-a,conv-b']);
    expect(Object.keys(stateAfter(files).threads)).toEqual([threadIdOf('<shared@example.com>')]);
  });

  it('two conversations with different roots stay two threads', async () => {
    const reader: MailReaderSeed = {
      folders: [folder()],
      pages: [
        {
          messages: [message({ id: 'a', conversationId: 'conv-a' }), message({ id: 'b', conversationId: 'conv-b', received: '2026-05-13T00:00:00Z' })],
          skipped: 0,
          deltaLink: 'c1',
        },
      ],
      headers: { a: [{ name: 'References', value: '<one@example.com>' }], b: [{ name: 'References', value: '<two@example.com>' }] },
    };
    const { asked } = await run({ reader, concurrency: 2 });

    expect([...asked].sort((left, right) => left.localeCompare(right))).toEqual(['conv-a', 'conv-b']);
  });

  // Built from the state the run folded, not from what it happened to render. An ordinary run
  // touches a handful of conversations out of thousands, and an index built from those would claim
  // the mailbox holds a handful of threads, dropping every other line on every incremental run.
  it('the index names every thread the mailbox holds, not only the ones this run wrote', async () => {
    const already = withThread(withConversation(emptyMailboxState(), 'conv-old', { threadId: 'thread-old', root: '<old@example.com>' }), 'thread-old', {
      folder: '2024-01-02-thread-old-earlier',
      conversationIds: ['conv-old'],
      file: 'threads/2024-01-02-thread-old-earlier/earlier.md',
      messageIds: ['m0'],
      lastMessage: '2024-01-02T00:00:00Z',
      attachments: [],
      inlineImages: [],
    });
    const { files } = await run({
      files: { texts: { [STATE_PATH]: serializeMailboxState(already) } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
    });
    const index = files.written.get('kb/Mailbox/_meta/threads.jsonl') ?? '';

    expect(index.split('\n').filter((line) => line.length > 0)).toHaveLength(2);
    expect(index).toContain('"thread_id":"thread-old"');
  });

  it('a run that wrote nothing still leaves an index behind, saying the mailbox holds nothing', async () => {
    const { files } = await run({ reader: { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'c1' }] } });

    expect(files.written.get('kb/Mailbox/_meta/threads.jsonl')).toBe('');
    expect(files.written.has('kb/Mailbox/_meta/attachments.jsonl')).toBe(true);
    expect(files.written.has('kb/Mailbox/_meta/links.jsonl')).toBe(true);
  });

  it('an index that cannot be written is said so and leaves the run standing', async () => {
    const { ok: succeeded, logger } = await run({
      files: { failWritesMatching: '_meta/links.jsonl' },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
    });

    expect(succeeded).toBe(true);
    expect(logger.calls.filter((call) => call.event === 'index.failed')).toEqual([
      { level: 'warn', event: 'index.failed', meta: { path: 'kb/Mailbox/_meta/links.jsonl', cause: 'write-failed' } },
    ]);
  });

  // The page a reader opens the mailbox by: every thread the state holds, the newest message first.
  it('the mailbox page lists every thread the mailbox holds, the one with the newest message first', async () => {
    const already = withThread(withConversation(emptyMailboxState(), 'conv-old', { threadId: 'thread-old', root: '<old@example.com>' }), 'thread-old', {
      folder: '2024-01-02-thread-old-earlier',
      conversationIds: ['conv-old'],
      file: '2024-01-02-thread-old-earlier/earlier.md',
      messageIds: ['m0'],
      lastMessage: '2024-01-02T00:00:00Z',
      attachments: [],
      inlineImages: [],
      subject: 'Earlier',
      lastFrom: 'Li Wei',
    });
    const { files } = await run({
      files: { texts: { [STATE_PATH]: serializeMailboxState(already) } },
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] },
      outcome: () => rendered({ thread: { ...rendered().thread, record: { ...rendered().thread.record, subject: 'Contrat Contoso', lastFrom: 'Jane Doe' } } }),
    });

    expect(files.written.get('kb/Mailbox/_index.md')).toBe(
      [
        '# Mailbox',
        '',
        '## By last message',
        '',
        '- 2026-05-12 · [Contrat Contoso](threads/2026-05-12/thread.md) · Jane Doe',
        '- 2024-01-02 · [Earlier](2024-01-02-thread-old-earlier/earlier.md) · Li Wei',
        '',
      ].join('\n')
    );
  });

  // One line per message beside the one per thread, written from the state on every run, with the
  // sent mail told apart by the addresses the sweep read.
  it('the message index lists each message beside the thread index, and a run with no change writes it the same', async () => {
    const message1 = {
      id: 'm1',
      received: '2026-05-12T09:31:00Z',
      subject: 'Contrat Contoso',
      from: { name: 'Jane Doe', address: 'jane@example.com' },
      to: [],
      cc: [],
      folderId: 'AAMk-inbox',
      flag: 'notFlagged',
      importance: 'normal',
      categories: [],
      folder: 'Inbox',
      draft: false,
      internetMessageId: '',
      preview: '',
      attachments: [],
      linked: [],
    };
    const outcome = (): RenderThreadOutcome => rendered({ thread: { ...rendered().thread, record: { ...rendered().thread.record, messages: [message1] } } });
    const reader = { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }], own: ['jane@example.com'] };
    const first = await run({ reader, outcome });
    const index = first.files.written.get('kb/Mailbox/_meta/messages.jsonl') ?? '';

    expect(index.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
    expect(JSON.parse(index)).toMatchObject({ message_id: 'm1', direction: 'sent', folder: 'Inbox', note: 'Mailbox/threads/2026-05-12/thread.md', position: '1/1' });

    const again = await run({ files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '' } }, reader: { ...reader, pages: [] } });

    expect(again.files.written.get('kb/Mailbox/_meta/messages.jsonl')).toBe(index);
  });

  it('the addresses the sweep read are kept, and a failed read keeps the ones held before', async () => {
    const kept = await run({ reader: { folders: [folder()], own: ['jane@example.com'] } });
    const held = serializeMailboxState({ ...emptyMailboxState(), ownAddresses: ['jane@example.com'] });
    const refused = { kind: 'transient' as const, message: 'throttled' };
    const failed = await run({ files: { texts: { [STATE_PATH]: held } }, reader: { folders: [folder()], failCalls: { ownAddresses: refused } } });

    expect(JSON.parse(kept.files.written.get(STATE_PATH) ?? '{}').ownAddresses).toEqual(['jane@example.com']);
    expect(JSON.parse(failed.files.written.get(STATE_PATH) ?? '{}').ownAddresses).toEqual(['jane@example.com']);
    expect(failed.logger.calls).toContainEqual({ level: 'warn', event: 'mail.owner-unread', meta: { cause: 'transient' } });
  });

  it('a dry run leaves no index behind, having written nothing to index', async () => {
    const { files } = await run({ dryRun: true, reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] } });

    expect([...files.written.keys()].filter((path) => path.includes('_meta/'))).toStrictEqual([]);
    expect(files.written.has('kb/Mailbox/_index.md')).toBe(false);
  });

  it('a window of conversations saves the state once, not once per conversation', async () => {
    const wide = await run({ reader: threeConversations, concurrency: 3 });
    const narrow = await run({ reader: threeConversations, concurrency: 1 });
    const savesAt = (files: FilesFake): number => files.writeLog.filter((path) => path === STATE_PATH).length;

    expect(savesAt(wide.files)).toBe(3);
    expect(savesAt(wide.files)).toBeLessThan(savesAt(narrow.files));
  });

  const twoConversations: MailReaderSeed = {
    folders: [folder()],
    pages: [
      { messages: [message({ id: 'a', conversationId: 'conv-a' }), message({ id: 'b', conversationId: 'conv-b', received: '2026-05-13T00:00:00Z' })], skipped: 0, deltaLink: 'c1' },
    ],
  };

  it('a conversation that fails in a window leaves the ones rendered beside it recorded', async () => {
    const { summary, files } = await run({ reader: twoConversations, failThread: 'conv-a', concurrency: 2 });

    expect(summary).toMatchObject({ converted: 1, failed: 1 });
    expect(Object.keys(stateAfter(files).threads)).toEqual([threadIdOf('b')]);
  });

  it('an empty conversation in a window leaves the ones rendered beside it recorded', async () => {
    const outcome = (input: RenderThreadInput): RenderThreadOutcome => (input.conversationIds.includes('conv-a') ? { kind: 'empty' } : rendered());
    const { summary, files } = await run({ reader: twoConversations, outcome, concurrency: 2 });

    expect(summary).toMatchObject({ converted: 1, skipped: 1 });
    expect(Object.keys(stateAfter(files).threads)).toEqual([threadIdOf('b')]);
  });
});

describe('the counter while the mailbox is read', () => {
  it('each folder is counted and named while it is read', async () => {
    const { progress } = await run({
      reader: {
        folders: [folder(), folder({ id: 'AAMk-archive', name: 'Archive' })],
        pages: [
          { messages: [], skipped: 0, deltaLink: 'c1' },
          { messages: [], skipped: 0, deltaLink: 'c2' },
        ],
      },
    });

    expect(progress.started[0]).toEqual({ total: 2, what: 'Mailbox, reading folders' });
    expect(progress.begins).toEqual(['Inbox', 'Archive']);
    expect(progress.steps).toEqual(['Inbox', 'Archive']);
  });

  it('a folder read over several pages shows how many messages it has read so far', async () => {
    const paged = (first: ReadonlyArray<MailMessage>, second: ReadonlyArray<MailMessage>): MailReaderSeed => ({
      folders: [folder()],
      pages: [
        { messages: first, skipped: 0, nextLink: 'n1' },
        { messages: second, skipped: 0, deltaLink: 'c1' },
      ],
    });

    const many = await run({ reader: paged([message({ id: 'a' }), message({ id: 'b' })], [message({ id: 'c' })]) });
    const one = await run({ reader: paged([message()], []) });

    expect(many.progress.details).toEqual([{ label: 'Inbox', what: '3 messages read' }]);
    expect(one.progress.details).toEqual([{ label: 'Inbox', what: '1 message read' }]);
  });
});

describe('a conversation the run could not write', () => {
  // No headers are seeded, so the root falls back to the message's own id.
  const THREAD = threadIdOf('m1');
  const REPORT_PATH = 'kb/Mailbox/_sync-report.md';
  // What the second run and every one after it sees: the cursors moved on when the first run swept,
  // so the folder delta reports nothing. Only what the last run wrote down can bring the thread back.
  const NOTHING_NEW = { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'c2' }] };

  const swept = async (): Promise<string> => {
    const first = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, failThread: 'conv-1' });
    return first.files.written.get(STATE_PATH) ?? '';
  };

  const again = async (carried: string, failing: boolean): Promise<Awaited<ReturnType<typeof run>>> =>
    run({ files: { texts: { [STATE_PATH]: carried } }, reader: NOTHING_NEW, ...(failing ? { failThread: 'conv-1' } : {}) });

  it('a conversation that could not be written is remembered against the run that failed it', async () => {
    const first = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, failThread: 'conv-1' });

    expect(first.summary).toMatchObject({ converted: 0, failed: 1 });
    expect(stateAfter(first.files).retry[THREAD]).toMatchObject({ attempts: 1, reason: 'thread refused' });
  });

  it('a conversation that could not be written is named under the heading promising another run, not the one that ends it', async () => {
    const first = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, failThread: 'conv-1' });
    const report = first.files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('Failed, and will be tried again on the next run:');
    expect(report).not.toContain('will not be tried again');
  });

  it('a conversation that could not be written is rendered again on the next run, although the delta reports nothing', async () => {
    const second = await again(await swept(), false);

    expect(second.asked).toEqual(['conv-1']);
    expect(second.summary).toMatchObject({ converted: 1, failed: 0 });
  });

  it('a conversation that renders on its second try leaves nothing behind to try a third time', async () => {
    const second = await again(await swept(), false);

    expect(stateAfter(second.files).retry).toEqual({});
  });

  it('a conversation that fails three runs running is left alone by the fourth', async () => {
    const second = await again(await swept(), true);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', true);
    const fourth = await again(third.files.written.get(STATE_PATH) ?? '', true);

    expect(third.summary).toMatchObject({ failed: 1 });
    expect(fourth.asked).toStrictEqual([]);
    expect(fourth.summary).toMatchObject({ converted: 0, failed: 0 });
    expect(stateAfter(fourth.files).retry[THREAD]).toMatchObject({ attempts: 3 });
  });

  it('a conversation out of tries is named in the report under the heading that says it will not be tried again', async () => {
    const second = await again(await swept(), true);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', true);
    const report = third.files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('Failed 3 times, and will not be tried again unless the file changes:');
    expect(report).toContain('- thread Contrat Contoso: thread refused');
    expect(report).not.toContain('will be tried again on the next run');
  });

  // Given up by an earlier run, so the mailbox's own report named it then and does not again. The
  // run still hands it on to the report of the whole run.
  it('a conversation given up on before subjects were kept is handed on by its id, all there is to call it', async () => {
    const givenUp = serializeMailboxState({ ...emptyMailboxState(), retry: { [THREAD]: { attempts: 3, reason: 'thread refused' } } });

    const { files, notes } = await run({ files: { texts: { [STATE_PATH]: givenUp } }, reader: NOTHING_NEW });

    expect(notes?.givenUp).toEqual([{ path: `thread ${THREAD}`, reason: 'thread refused' }]);
    expect(notes?.gaveUp).toBeUndefined();
    expect(files.written.has(REPORT_PATH)).toBe(false);
  });

  it('a conversation that gained a reply after it was given up on is written again from scratch', async () => {
    const second = await again(await swept(), true);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', true);
    const replied = await run({
      files: { texts: { [STATE_PATH]: third.files.written.get(STATE_PATH) ?? '' } },
      reader: { folders: [folder()], pages: [{ messages: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })], skipped: 0, deltaLink: 'c3' }] },
    });

    expect(replied.asked).toEqual(['conv-1']);
    expect(replied.summary).toMatchObject({ converted: 1 });
    expect(stateAfter(replied.files).retry).toEqual({});
  });
});

describe('a thread that renders while one of its files does not', () => {
  // No headers are seeded, so the root falls back to the message's own id.
  const THREAD = threadIdOf('m1');
  const REPORT_PATH = 'kb/Mailbox/_sync-report.md';
  const NOTHING_NEW = { folders: [folder()], pages: [{ messages: [], skipped: 0, deltaLink: 'c2' }] };
  const OWING: RenderThreadOutcome = rendered({
    thread: { ...rendered().thread, filesFailed: [{ path: 'threads/2026-05-12/thread.md: c.docx', reason: 'locked' }] },
  });

  const swept = async (outcome: RenderThreadOutcome): Promise<string> => {
    const first = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome: () => outcome });
    return first.files.written.get(STATE_PATH) ?? '';
  };

  const again = async (carried: string, outcome: RenderThreadOutcome): Promise<Awaited<ReturnType<typeof run>>> =>
    run({ files: { texts: { [STATE_PATH]: carried } }, reader: NOTHING_NEW, outcome: () => outcome });

  it('a thread whose attachment could not be read is rendered again on the next run, although the delta reports nothing', async () => {
    const first = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome: () => OWING });
    const second = await again(first.files.written.get(STATE_PATH) ?? '', OWING);

    expect(stateAfter(first.files).retry[THREAD]).toEqual({ attempts: 1, reason: 'threads/2026-05-12/thread.md: c.docx: locked' });
    expect(second.asked).toEqual(['conv-1']);
  });

  it('a file a thread still owes is named under the heading promising another run, not the one that ends it', async () => {
    const first = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome: () => OWING });
    const report = first.files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('Failed, and will be tried again on the next run:');
    expect(report).toContain('- threads/2026-05-12/thread.md: c.docx: locked');
    expect(report).not.toContain('will not be tried again');
  });

  it('a thread whose files all landed leaves nothing behind to render again', async () => {
    const first = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] } });

    expect(stateAfter(first.files).retry).toEqual({});
  });

  it('a thread that recovers its file on the second try leaves nothing behind to try a third time', async () => {
    const second = await again(await swept(OWING), rendered());

    expect(stateAfter(second.files).retry).toEqual({});
  });

  it('a thread still owing a file after three tries is left alone by the fourth', async () => {
    const second = await again(await swept(OWING), OWING);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', OWING);
    const fourth = await again(third.files.written.get(STATE_PATH) ?? '', OWING);

    expect(third.asked).toEqual(['conv-1']);
    expect(fourth.asked).toStrictEqual([]);
    expect(stateAfter(fourth.files).retry).toEqual({});
  });

  it('the file a thread gave up on is named in the report, not the thread that carried it', async () => {
    const second = await again(await swept(OWING), OWING);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', OWING);
    const report = third.files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('Failed 3 times, and will not be tried again unless the file changes:');
    expect(report).toContain('- threads/2026-05-12/thread.md: c.docx: locked');
    expect(report).not.toContain(`- thread ${THREAD}`);
  });
});
