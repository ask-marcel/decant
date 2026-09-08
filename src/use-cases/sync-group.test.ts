import { describe, expect, it } from 'bun:test';
import { emptyGroupState, serializeGroupState, withGroupThread } from '../domain/group-state.ts';
import { threadRef } from '../domain/group-thread.ts';
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
    // The thread whose render refuses, by id, so one thread can fail while another lands beside it.
    failThread?: string;
  } = {}
): Promise<{
  summary: RunSummary;
  source: string;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  progress: ProgressFake;
  asked: RenderThreadInput[];
  roots: string[];
  names: string[];
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const asked: RenderThreadInput[] = [];
  const roots: string[] = [];
  const names: string[] = [];
  const syncGroup = createSyncGroup({
    reader: createGroupReaderFake({ threads: { '0d3b-group': [thread()] }, ...seeds.reader }),
    files,
    logger,
    progress,
    clock: createClockFake(),
    kbRoot: 'kb',
    renderThreadFor: (root, name) => async (input) => {
      names.push(name);
      asked.push(input);
      roots.push(root);
      if (seeds.failThread !== undefined && input.conversationIds.includes(threadRef(GROUP.id, seeds.failThread)))
        return err({ kind: 'permanent' as const, message: 'thread refused' });
      return ok(seeds.outcome === undefined ? rendered() : seeds.outcome(input));
    },
  });
  const result = await syncGroup({ group: GROUP, maxBytes: 50 * 1024 * 1024, dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 1 });
  return {
    summary: result.ok ? result.value.summary : ({} as RunSummary),
    source: result.ok ? result.value.source : '',
    notes: result.ok ? result.value.notes : { skipped: [], failed: [], givenUp: [], archived: [] },
    files,
    logger,
    progress,
    asked,
    roots,
    names,
    ok: result.ok,
    error: result.ok ? undefined : result.error,
  };
};

const stateAfter = (files: FilesFake): { threads: Record<string, { lastMessage?: string }>; retry: Record<string, { attempts: number; reason: string }> } =>
  JSON.parse(files.written.get(STATE_PATH) ?? '{}');

describe('mirroring a group inbox into the knowledge base', () => {
  it('a group nobody has synced before has every thread it holds written as a document', async () => {
    const { summary, asked, files } = await run();

    expect(summary.converted).toBe(1);
    expect(asked[0]).toMatchObject({ conversationIds: ['0d3b-group|AAQkAD-thread'], root: 'AAQkAD-thread', folder: '' });
    expect(Object.keys(stateAfter(files).threads)).toEqual(['AAQkAD-thread']);
  });

  it('a group is filed apart from the SharePoint site of the same name', async () => {
    const { files, roots, names } = await run();

    expect(files.written.has(STATE_PATH)).toBe(true);
    expect(roots).toEqual(['kb/MOOV Leadership Team (group inbox)']);
    expect(names).toEqual(['MOOV Leadership Team']);
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
    const { summary, notes, logger } = await run({ failThread: 'AAQkAD-thread' });

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
    expect(notes).toEqual({ skipped: [], failed: [], givenUp: [], archived: [] });
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

describe('naming a group inbox in a report', () => {
  it('a group run names itself a group inbox, so a site of the same name reads apart', async () => {
    const outcome = (): RenderThreadOutcome => rendered({ filesFailed: [{ path: 'budget.xlsx', reason: 'locked' }] });
    const { files } = await run({ outcome });

    expect(files.written.get('kb/MOOV Leadership Team (group inbox)/_sync-report.md')).toContain('# What did not reach the knowledge base: MOOV Leadership Team (group inbox)');
  });

  it('the run hands the same name back, so the report covering every source reads apart too', async () => {
    const { source } = await run();

    expect(source).toBe('MOOV Leadership Team (group inbox)');
  });
});

describe('a group thread the run could not write', () => {
  const REPORT_PATH = 'kb/MOOV Leadership Team (group inbox)/_sync-report.md';
  // The listing Graph hands back every run, newest first: it has no cursor, so the same two threads
  // arrive whatever happened last time. `late` lands and puts the watermark past `early`, which is
  // what used to make a failure on `early` unreachable for good.
  const early = thread({ id: 'early', topic: 'Budget review', lastDelivered: '2026-07-20T10:45:14Z' });
  const late = thread({ id: 'late', topic: 'Offsite agenda', lastDelivered: '2026-07-25T09:00:00Z' });
  const LISTING = { threads: { '0d3b-group': [late, early] } };

  const askedFor = (results: { readonly asked: RenderThreadInput[] }): ReadonlyArray<string> =>
    results.asked.map((input) => input.conversationIds.join(',').replace(`${GROUP.id}|`, ''));

  const isThread = (input: RenderThreadInput, id: string): boolean => input.conversationIds.includes(threadRef(GROUP.id, id));

  // A rendered thread records the date it was delivered, which is what the watermark is drawn from.
  // A fixed date for both would leave `late` above the watermark it set itself.
  const landed = (input: RenderThreadInput): RenderThreadOutcome =>
    rendered({ record: { ...RECORD, lastMessage: isThread(input, 'late') ? late.lastDelivered : early.lastDelivered } });

  const again = async (carried: string, failing: string | undefined): Promise<Awaited<ReturnType<typeof run>>> =>
    run({ files: { texts: { [STATE_PATH]: carried } }, reader: LISTING, outcome: landed, ...(failing === undefined ? {} : { failThread: failing }) });

  const swept = async (): Promise<string> => {
    const first = await run({ reader: LISTING, outcome: landed, failThread: 'early' });
    return first.files.written.get(STATE_PATH) ?? '';
  };

  it('a thread that could not be rendered comes back on the next run, although a newer thread moved the watermark past it', async () => {
    const first = await run({ reader: LISTING, outcome: landed, failThread: 'early' });
    const second = await again(first.files.written.get(STATE_PATH) ?? '', undefined);

    expect(first.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(stateAfter(first.files).retry['early']).toEqual({ attempts: 1, reason: 'thread refused' });
    expect(askedFor(second)).toEqual(['early']);
    expect(stateAfter(second.files).retry).toEqual({});
  });

  it('a thread that fails three runs running is left alone by the fourth', async () => {
    const second = await again(await swept(), 'early');
    const third = await again(second.files.written.get(STATE_PATH) ?? '', 'early');
    const fourth = await again(third.files.written.get(STATE_PATH) ?? '', 'early');

    expect(askedFor(third)).toEqual(['early']);
    expect(askedFor(fourth)).toEqual([]);
    expect(stateAfter(fourth.files).retry['early']).toMatchObject({ attempts: 3 });
  });

  it('a thread that renders while one of its files does not comes back on the next run', async () => {
    const owing = (input: RenderThreadInput): RenderThreadOutcome =>
      isThread(input, 'early') ? rendered({ record: { ...RECORD, lastMessage: early.lastDelivered }, filesFailed: [{ path: 'budget.xlsx', reason: 'locked' }] }) : landed(input);
    const first = await run({ reader: LISTING, outcome: owing });
    const second = await run({ files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '' } }, reader: LISTING, outcome: owing });

    expect(stateAfter(first.files).retry['early']).toEqual({ attempts: 1, reason: 'budget.xlsx: locked' });
    expect(askedFor(second)).toEqual(['early']);
  });

  it('a thread still owing a file after three tries is left alone by the fourth, and the file is named as given up', async () => {
    const owing = (input: RenderThreadInput): RenderThreadOutcome =>
      isThread(input, 'early') ? rendered({ record: { ...RECORD, lastMessage: early.lastDelivered }, filesFailed: [{ path: 'budget.xlsx', reason: 'locked' }] }) : landed(input);
    const owed = async (carried: string): Promise<Awaited<ReturnType<typeof run>>> => run({ files: { texts: { [STATE_PATH]: carried } }, reader: LISTING, outcome: owing });
    const first = await run({ reader: LISTING, outcome: owing });
    const second = await owed(first.files.written.get(STATE_PATH) ?? '');
    const third = await owed(second.files.written.get(STATE_PATH) ?? '');
    const fourth = await owed(third.files.written.get(STATE_PATH) ?? '');

    expect(askedFor(third)).toEqual(['early']);
    expect(askedFor(fourth)).toEqual([]);
    expect(stateAfter(third.files).retry).toEqual({});
    expect(third.notes.givenUp).toEqual([{ path: 'budget.xlsx', reason: 'locked' }]);
    expect(third.files.written.get(REPORT_PATH)).toContain('- budget.xlsx: locked');
  });

  it('a thread given up on and since dropped from the group is named by its id, having no topic left', async () => {
    const second = await again(await swept(), 'early');
    const third = await again(second.files.written.get(STATE_PATH) ?? '', 'early');
    const dropped = await run({
      files: { texts: { [STATE_PATH]: third.files.written.get(STATE_PATH) ?? '' } },
      reader: { threads: { '0d3b-group': [late] } },
      outcome: landed,
    });

    expect(dropped.files.written.get(REPORT_PATH)).toContain('- thread early: thread refused');
  });

  it('a thread out of tries is named in the report by its topic, under the heading that says it will not be tried again', async () => {
    const second = await again(await swept(), 'early');
    const third = await again(second.files.written.get(STATE_PATH) ?? '', 'early');
    const report = third.files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('Could not be read after 3 tries, and will not be tried again unless the file changes:');
    expect(report).toContain('- thread Budget review: thread refused');
    expect(report).not.toContain('will be tried again on the next run');
  });
});
