import { describe, expect, it } from 'bun:test';
import type { MailFolder } from '../domain/mail-folder.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import { serializeMailboxState, emptyMailboxState, withConversation, withThread } from '../domain/mail-state.ts';
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
import type { RunSummary } from './sync-site.ts';
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

const rendered = (over: Partial<RenderThreadOutcome> = {}): RenderThreadOutcome => ({
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
  files: FilesFake;
  logger: LoggerFake;
  progress: ProgressFake;
  asked: string[];
  ok: boolean;
  error?: StepError;
  reader: ReturnType<typeof createMailReaderFake>;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const reader = createMailReaderFake(seeds.reader);
  const asked: string[] = [];
  const syncMailbox = createSyncMailbox({
    reader,
    files,
    logger,
    progress,
    clock: createClockFake(),
    kbRoot: 'kb',
    renderThread: async (input) => {
      asked.push(input.conversationIds.join(','));
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
  return { summary: result.ok ? result.value.summary : ({} as RunSummary), files, logger, progress, asked, ok: result.ok, error: result.ok ? undefined : result.error, reader };
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

    expect(reader.calls.filter((call) => call.startsWith('headers:'))).toEqual([]);
  });

  // Left unresolved rather than guessed at. The root names a folder written once and never rebuilt,
  // so a guess is permanent where an absence is retried on the next sweep.
  it('a conversation whose root cannot be read is left unresolved and said so', async () => {
    const { files, logger, summary } = await run({
      reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }], failCalls: { messageHeaders: { kind: 'transient', message: 'throttled' } } },
    });

    expect(stateAfter(files).conversations).toEqual({});
    // Never queued: a thread cannot be rendered before it is known which one it is.
    expect(stateAfter(files).pending).toEqual([]);
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

    expect(asked).toEqual([]);
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

    expect(stateAfter(files).pending).toEqual([]);
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

    expect(asked).toEqual([]);
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

    expect(asked).toEqual([]);
    expect(summary.converted).toBe(0);
  });

  it('a conversation that gained a reply is written again, in place', async () => {
    const reader = { folders: [folder()], pages: [{ messages: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })], skipped: 0, deltaLink: 'c1' }] };
    const { asked } = await run({ files: { texts: { [STATE_PATH]: known } }, reader });

    expect(asked).toEqual(['conv-1']);
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

  it('without a day asked for, everything the sweep returned is written', async () => {
    const messages = [message({ id: 'old', conversationId: 'conv-old', received: '2024-01-01T00:00:00Z' })];
    const { asked } = await run({ reader: { folders: [folder()], pages: [{ messages, skipped: 0, deltaLink: 'c1' }] } });

    expect(asked).toEqual(['conv-old']);
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
            { path: 'a.mp4', reason: 'a kind of file this tool does not read' },
            { path: 'b.mov', reason: 'a kind of file this tool does not read' },
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
          filesSkipped: [{ path: 'Demo.mp4', reason: 'a kind of file this tool does not read' }],
          filesFailed: [{ path: 'Contrat.docx', reason: 'permanent: cannot convert' }],
        },
      });
    const { files } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, outcome });
    const report = files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('# What did not reach the knowledge base: Mailbox');
    expect(report).toContain('- Demo.mp4: a kind of file this tool does not read');
    expect(report).toContain('- Contrat.docx: permanent: cannot convert');
  });

  it('a conversation that could not be written is named in the report', async () => {
    const { files, logger } = await run({ reader: { folders: [folder()], pages: [{ messages: [message()], skipped: 0, deltaLink: 'c1' }] }, failThread: 'conv-1' });

    expect(files.written.get(REPORT_PATH)).toContain(`- thread ${threadIdOf('m1')}: thread refused`);
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
          message({ id: 'a', conversationId: 'conv-a' }),
          message({ id: 'b', conversationId: 'conv-b', received: '2026-05-13T00:00:00Z' }),
          message({ id: 'c', conversationId: 'conv-c', received: '2026-05-14T00:00:00Z' }),
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

  it('the progress counter shows the total up front and ticks once per conversation', async () => {
    const { progress } = await run({ reader: threeConversations, concurrency: 3 });

    expect(progress.started).toEqual([{ total: 3, what: 'Rendering' }]);
    expect(progress.steps).toHaveLength(3);
    expect(progress.dones).toHaveLength(1);
  });

  it('every conversation in the window announces itself as begun before any of them finish', async () => {
    const { progress } = await run({ reader: threeConversations, concurrency: 3 });

    expect([...progress.begins].sort((left, right) => left.localeCompare(right))).toEqual(
      [threadIdOf('a'), threadIdOf('b'), threadIdOf('c')].sort((left, right) => left.localeCompare(right))
    );
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
