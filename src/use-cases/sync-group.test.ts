import { describe, expect, it } from 'bun:test';
import { emptyGroupState, serializeGroupState, withGroupThread } from '../domain/group-state.ts';
import type { GroupThread } from '../domain/group-thread.ts';
import type { ThreadRecord } from '../domain/mail-state.ts';
import { err, ok } from '../domain/result.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createGroupReaderFake } from '../test-helpers/group-reader-fake.ts';
import type { GroupReaderSeed } from '../test-helpers/group-reader-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import type { RenderThreadInput, RenderThreadOutcome, RenderedThread } from './render-thread.ts';
import { createSyncGroup } from './sync-group.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';
import type { StepError } from './ports/step-error.ts';

const GROUP = { id: '0d3b-group', name: 'MOOV Leadership Team', mail: 'MOOVLeadershipTeam@example.com' };

const STATE_PATH = 'kb/MOOV Leadership Team (group inbox)/.sync-state.json';

const thread = (over: Partial<GroupThread> = {}): GroupThread => ({
  id: 'AAQkAD-thread',
  topic: 'Bi-Monthly Leadership Meeting',
  lastDelivered: '2026-07-20T10:45:14Z',
  hasAttachments: false,
  ...over,
});

const RECORD: ThreadRecord = {
  folder: '2026-07-20-abc1234567-bi-monthly-leadership-meeting',
  conversationIds: ['0d3b-group|AAQkAD-thread'],
  file: 'threads/2026-07-20-abc1234567-bi-monthly-leadership-meeting/bi-monthly-leadership-meeting.md',
  messageIds: ['0d3b-group|AAQkAD-thread|AAMkAD-post'],
  lastMessage: '2026-07-20T10:45:14Z',
  attachments: [],
  inlineImages: [],
};

const rendered = (over: Partial<RenderedThread> = {}): RenderThreadOutcome => ({
  kind: 'rendered',
  thread: { record: RECORD, linked: {}, attachments: {}, filesSkipped: [], filesFailed: [], ...over },
});

const run = async (
  seeds: {
    reader?: GroupReaderSeed;
    files?: FilesFakeSeed;
    dryRun?: boolean;
    concurrency?: number;
    outcome?: (input: RenderThreadInput) => RenderThreadOutcome;
    failThread?: boolean;
  } = {}
): Promise<{
  summary: RunSummary;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  progress: ProgressFake;
  asked: RenderThreadInput[];
  roots: string[];
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const asked: RenderThreadInput[] = [];
  const roots: string[] = [];
  const syncGroup = createSyncGroup({
    reader: createGroupReaderFake({ threads: { '0d3b-group': [thread()] }, ...seeds.reader }),
    files,
    logger,
    progress,
    clock: createClockFake(),
    kbRoot: 'kb',
    renderThreadFor: (root) => async (input) => {
      asked.push(input);
      roots.push(root);
      if (seeds.failThread === true) return err({ kind: 'permanent' as const, message: 'thread refused' });
      return ok(seeds.outcome === undefined ? rendered() : seeds.outcome(input));
    },
  });
  const result = await syncGroup({ group: GROUP, maxBytes: 50 * 1024 * 1024, dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 1 });
  return {
    summary: result.ok ? result.value.summary : ({} as RunSummary),
    notes: result.ok ? result.value.notes : { skipped: [], failed: [], archived: [] },
    files,
    logger,
    progress,
    asked,
    roots,
    ok: result.ok,
    error: result.ok ? undefined : result.error,
  };
};

const stateAfter = (files: FilesFake): { threads: Record<string, { lastMessage?: string }> } => JSON.parse(files.written.get(STATE_PATH) ?? '{}');

describe('mirroring a group inbox into the knowledge base', () => {
  it('a group nobody has synced before has every thread it holds written as a document', async () => {
    const { summary, asked, files } = await run();

    expect(summary.converted).toBe(1);
    expect(asked[0]).toMatchObject({ conversationIds: ['0d3b-group|AAQkAD-thread'], root: 'AAQkAD-thread', folder: '' });
    expect(Object.keys(stateAfter(files).threads)).toEqual(['AAQkAD-thread']);
  });

  it('a group is filed apart from the SharePoint site of the same name', async () => {
    const { files, roots } = await run();

    expect(files.written.has(STATE_PATH)).toBe(true);
    expect(roots).toEqual(['kb/MOOV Leadership Team (group inbox)']);
  });

  it('a second run over an unchanged group writes nothing, since every thread is already held', async () => {
    const held = withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD);
    const { summary, asked } = await run({ files: { texts: { [STATE_PATH]: serializeGroupState(held) } } });

    expect(summary.converted).toBe(0);
    expect(asked).toEqual([]);
  });

  it('a thread that has been replied to since the last run comes back, because its newest post moved', async () => {
    const held = withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD);
    const { summary, asked } = await run({
      files: { texts: { [STATE_PATH]: serializeGroupState(held) } },
      reader: { threads: { '0d3b-group': [thread({ lastDelivered: '2026-08-10T05:40:15Z' })] } },
    });

    expect(summary.converted).toBe(1);
    expect(asked[0]?.folder).toBe('2026-07-20-abc1234567-bi-monthly-leadership-meeting');
  });

  it('threads are rendered oldest first, so a stopped run leaves a prefix of the history', async () => {
    const { asked } = await run({
      reader: {
        threads: {
          '0d3b-group': [
            thread({ id: 'newest', lastDelivered: '2026-08-10T05:40:15Z' }),
            thread({ id: 'middle', lastDelivered: '2026-07-20T10:45:14Z' }),
            thread({ id: 'oldest', lastDelivered: '2026-06-16T06:45:11Z' }),
          ],
        },
      },
    });

    expect(asked.map((input) => input.root)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('a dry run says how much there is to do and writes nothing at all', async () => {
    const { summary, files, asked } = await run({ dryRun: true });

    expect(summary.queued).toBe(1);
    expect(asked).toEqual([]);
    expect(files.written.size).toBe(0);
  });

  it('a group the signed-in user cannot read stops the run and says which step refused', async () => {
    const { ok: succeeded, error } = await run({ reader: { failThreads: { kind: 'permanent', message: 'ErrorAccessDenied' } } });

    expect(succeeded).toBe(false);
    expect(error).toMatchObject({ step: 'listThreads', message: 'ErrorAccessDenied' });
  });

  it('a thread that cannot be rendered is counted and named in the report, not merely logged', async () => {
    const { summary, notes, logger } = await run({ failThread: true });

    expect(summary).toMatchObject({ converted: 0, failed: 1, skipped: 0 });
    expect(notes.failed).toEqual([{ path: 'thread Bi-Monthly Leadership Meeting', reason: 'thread refused' }]);
    expect(logger.calls.some((entry) => entry.event === 'group-thread.failed')).toBe(true);
  });

  it('what a thread could not carry is counted and reported beside the thread itself', async () => {
    const { summary, notes } = await run({
      outcome: () =>
        rendered({
          filesSkipped: [{ path: 'Tender.zip', reason: 'larger than the 50 MB cap' }],
          filesFailed: [{ path: 'Scan.pdf', reason: 'permanent: refused' }],
        }),
    });

    expect(summary).toMatchObject({ converted: 1, skipped: 1, failed: 1 });
    expect(notes.skipped).toEqual([{ path: 'Tender.zip', reason: 'larger than the 50 MB cap' }]);
    expect(notes.failed).toEqual([{ path: 'Scan.pdf', reason: 'permanent: refused' }]);
  });

  it('the operator is told which group is being read and which thread is being written', async () => {
    const { progress } = await run();

    expect(progress.started).toEqual([{ total: 1, what: 'MOOV Leadership Team (group inbox)' }]);
    expect(progress.begins).toEqual(['Bi-Monthly Leadership Meeting']);
    expect(progress.steps).toEqual(['Bi-Monthly Leadership Meeting']);
  });

  it('a thread the renderer found nothing in is skipped rather than recorded as written', async () => {
    const { summary, notes, files } = await run({ outcome: () => ({ kind: 'empty' }) });

    expect(summary).toMatchObject({ converted: 0, skipped: 1, failed: 0 });
    expect(notes).toEqual({ skipped: [], failed: [], archived: [] });
    expect(stateAfter(files).threads).toEqual({});
  });

  it('a state file this code cannot read is started over rather than written back over', async () => {
    const { summary, logger } = await run({ files: { texts: { [STATE_PATH]: '{ "version": 99, "source": { "kind": "group" } }' } } });

    expect(summary.converted).toBe(1);
    expect(logger.calls.some((entry) => entry.event === 'group-state.unreadable')).toBe(true);
  });

  it('a run that cannot record what it did stops there, rather than carrying on and losing the record', async () => {
    const { ok: succeeded, error } = await run({ files: { failWritesMatching: '.sync-state.json' } });

    expect(succeeded).toBe(false);
    expect(error).toMatchObject({ step: 'saveState' });
  });

  it('what a thread carried is remembered, so a second thread naming the same file does not fetch it twice', async () => {
    const { files } = await run({
      outcome: () => rendered({ linked: { 'https://x/Spec.docx': { paths: ['_linked/Spec.docx.md'] } } }),
    });
    const saved = JSON.parse(files.written.get(STATE_PATH) ?? '{}');

    expect(saved.linked).toEqual({ 'https://x/Spec.docx': { paths: ['_linked/Spec.docx.md'] } });
  });
});
