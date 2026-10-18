import { describe, expect, it } from 'bun:test';
import { emptyGroupState, serializeGroupState, withGroupThread } from '../domain/group-state.ts';
import type { GroupState } from '../domain/group-state.ts';
import { threadRef } from '../domain/group-thread.ts';
import { threadIdOf } from '../domain/thread-id.ts';
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

const GROUP = { id: '0d3b-group', name: 'Northwind Leadership Team', mail: 'NorthwindLeadershipTeam@example.com' };

const STATE_PATH = 'kb/Group inboxes/Northwind Leadership Team/.sync-state.json';

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
    since?: string;
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
  const result = await syncGroup({ group: GROUP, maxBytes: 50 * 1024 * 1024, dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 1, since: seeds.since });
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

const stateAfter = (files: FilesFake): { threads: Record<string, { lastMessage?: string }>; retry: Record<string, { attempts: number; reason: string }>; lastRun?: string } =>
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
    expect(roots).toEqual(['kb/Group inboxes/Northwind Leadership Team']);
    expect(names).toEqual(['Northwind Leadership Team']);
  });

  it('a second run over an unchanged group writes nothing, since every thread is already held', async () => {
    const held = withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD);
    const { summary, asked } = await run({ files: { texts: { [STATE_PATH]: serializeGroupState(held) } } });

    expect(summary.converted).toBe(0);
    expect(asked).toStrictEqual([]);
  });

  it('a run that found nothing new still records that it ran, so a later report does not call it stale', async () => {
    const held = withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD);
    const { asked, files } = await run({ files: { texts: { [STATE_PATH]: serializeGroupState(held) } } });

    expect(asked).toStrictEqual([]);
    expect(stateAfter(files).lastRun).toBe('2026-07-23T14:00:00Z');
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

  // A state that could not be read starts over, and the folder of each thread is found again by the
  // id in its name rather than made a second time.
  it('a thread the state holds no record of is written into the folder already on disk for its id', async () => {
    const id = threadIdOf('AAQkAD-thread');
    const { asked } = await run({
      files: { directories: { 'kb/Group inboxes/Northwind Leadership Team/threads': ['2026-07-19-0123456789-other', `2026-07-19-${id}-bi-monthly-meeting`] } },
    });

    expect(asked.map((input) => input.folder)).toEqual([`2026-07-19-${id}-bi-monthly-meeting`]);
  });

  // The note keeps its name the way the folder does, and a thread never written is handed none.
  it('a thread written again is handed the path of its note, and a new thread none', async () => {
    const held = withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD);
    const again = await run({
      files: { texts: { [STATE_PATH]: serializeGroupState(held) } },
      reader: { threads: { '0d3b-group': [thread({ lastDelivered: '2026-08-10T05:40:15Z' })] } },
    });
    const fresh = await run();

    expect(again.asked.map((input) => input.file)).toEqual([RECORD.file]);
    expect(fresh.asked.map((input) => input.file)).toEqual([undefined]);
    expect(fresh.asked).toHaveLength(1);
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
    expect(asked).toStrictEqual([]);
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

    expect(progress.started).toEqual([{ total: 1, what: 'Northwind Leadership Team (group inbox)' }]);
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
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'group-state.unreadable', meta: { group: '0d3b-group', cause: 'state is version 99, not 1' } });
  });

  it('a run that cannot record what it did stops there, rather than carrying on and losing the record', async () => {
    const { ok: succeeded, error } = await run({ files: { failWritesMatching: '.sync-state.json' } });

    expect(succeeded).toBe(false);
    expect(error).toMatchObject({ step: 'saveState' });
  });

  it('a run that found nothing new and cannot record that it ran stops rather than reporting success', async () => {
    const held = withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD);
    const { ok: succeeded, error } = await run({ files: { texts: { [STATE_PATH]: serializeGroupState(held) }, failWritesMatching: '.sync-state.json' } });

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

describe('the files a group thread written again no longer holds', () => {
  const HERE = `kb/Group inboxes/Northwind Leadership Team/threads/${RECORD.folder}`;
  const A = `${HERE}/_attachments/a.pdf.md`;
  const B = `${HERE}/_attachments/b.pdf.md`;
  const replied = { threads: { '0d3b-group': [thread({ lastDelivered: '2026-08-10T05:40:15Z' })] } };
  const held = (over: Partial<GroupState> = {}): string =>
    serializeGroupState({ ...withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', { ...RECORD, files: [A, B] }), ...over });

  it('a file the thread no longer holds goes under the archive and is named in the report', async () => {
    const { files, summary, notes } = await run({
      files: { texts: { [STATE_PATH]: held(), [A]: 'a', [B]: 'b' } },
      reader: replied,
      outcome: () => rendered({ record: { ...RECORD, files: [A] } }),
    });

    expect(files.moves).toEqual([{ from: B, to: `kb/_archive/2026-07-23/Group inboxes/Northwind Leadership Team/threads/${RECORD.folder}/_attachments/b.pdf.md` }]);
    expect(summary).toMatchObject({ converted: 1, archived: 1 });
    expect(notes.archived).toEqual([{ path: `threads/${RECORD.folder}/_attachments/b.pdf.md`, reason: 'no longer in the thread' }]);
  });

  it('a write that could not read a file the thread held keeps that file, and puts aside the rest', async () => {
    const { files, summary } = await run({
      files: { texts: { [STATE_PATH]: held(), [A]: 'a', [B]: 'b' } },
      reader: replied,
      outcome: () => rendered({ record: { ...RECORD, files: [] }, filesFailed: [{ path: 'a.pdf', reason: 'throttled: slow down' }], unread: [`${HERE}/_attachments/a.pdf`] }),
    });
    const saved = JSON.parse(files.written.get(STATE_PATH) ?? '{}');

    expect(files.moves.map((move: { from: string }) => move.from)).toEqual([B]);
    expect(summary.archived).toBe(1);
    expect(saved.threads['AAQkAD-thread'].files).toEqual([A]);
  });

  it('the stored records of a file put aside leave the state', async () => {
    const stored = { name: 'b.pdf', paths: [B], primary: B, media: [] };
    const { files } = await run({
      files: { texts: { [STATE_PATH]: held({ attachments: { hash: stored }, linked: { 'b!one:01ABC': { paths: [B] } } }), [A]: 'a', [B]: 'b' } },
      reader: replied,
      outcome: () => rendered({ record: { ...RECORD, files: [A] } }),
    });
    const saved = JSON.parse(files.written.get(STATE_PATH) ?? '{}');

    expect(saved.attachments).toEqual({});
    expect(saved.linked).toEqual({});
  });
});

describe('a group thread with no post left', () => {
  const NOTE = `kb/Group inboxes/Northwind Leadership Team/${RECORD.file}`;

  it('goes under the archive whole, is named in the report, and leaves the state', async () => {
    const held = { ...withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD), retry: { 'AAQkAD-thread': { attempts: 1, reason: 'a.pdf: locked' } } };
    const { files, summary, notes } = await run({
      files: { texts: { [STATE_PATH]: serializeGroupState(held), [NOTE]: 'note' } },
      reader: { threads: { '0d3b-group': [thread({ lastDelivered: '2026-08-10T05:40:15Z' })] } },
      outcome: () => ({ kind: 'empty' }),
    });

    expect(files.moves).toEqual([{ from: NOTE, to: `kb/_archive/2026-07-23/Group inboxes/Northwind Leadership Team/${RECORD.file}` }]);
    expect(summary).toMatchObject({ converted: 0, archived: 1, skipped: 0 });
    expect(notes.archived).toEqual([{ path: RECORD.file, reason: 'no message left at the source' }]);
    expect(stateAfter(files).threads).toEqual({});
    expect(stateAfter(files).retry).toEqual({});
  });
});

describe('a group thread the group no longer lists', () => {
  const NOTE = `kb/Group inboxes/Northwind Leadership Team/${RECORD.file}`;
  const held = serializeGroupState(withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD));

  // The listing is whole on every run, so a thread missing from it was deleted in the group.
  it('goes under the archive whole, is named in the report, and leaves the state', async () => {
    const other = thread({ id: 'other', topic: 'Offsite agenda', lastDelivered: '2026-08-10T05:40:15Z' });
    const { files, summary, notes, asked } = await run({
      files: { texts: { [STATE_PATH]: held, [NOTE]: 'note' } },
      reader: { threads: { '0d3b-group': [other] } },
      outcome: () => rendered({ record: { ...RECORD, folder: 'other-folder', file: 'threads/other-folder/offsite-agenda.md' } }),
    });

    expect(asked.map((input) => input.root)).toEqual(['other']);
    expect(files.moves).toEqual([{ from: NOTE, to: `kb/_archive/2026-07-23/Group inboxes/Northwind Leadership Team/${RECORD.file}` }]);
    expect(summary).toMatchObject({ converted: 1, archived: 1 });
    expect(notes.archived).toEqual([{ path: RECORD.file, reason: 'no longer at the source' }]);
    expect(Object.keys(stateAfter(files).threads)).toEqual(['other']);
  });

  // A group the user can no longer read refuses the listing; an empty answer is most often a fault,
  // and taking it at its word would move the whole inbox aside.
  it('an empty listing moves nothing aside, and the run says so in the log', async () => {
    const { files, logger, summary } = await run({ files: { texts: { [STATE_PATH]: held, [NOTE]: 'note' } }, reader: { threads: { '0d3b-group': [] } } });

    expect(files.moves).toStrictEqual([]);
    expect(summary.archived).toBe(0);
    expect(Object.keys(stateAfter(files).threads)).toEqual(['AAQkAD-thread']);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'group.listing-empty', meta: { group: '0d3b-group', threads: 1 } });
  });

  it('a thread whose note will not move keeps its record and is tried again', async () => {
    const { files, summary, notes } = await run({
      files: { texts: { [STATE_PATH]: held, [NOTE]: 'note' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'locked' } },
      reader: { threads: { '0d3b-group': [thread({ id: 'other', lastDelivered: '2026-07-01T00:00:00Z' })] } },
    });

    expect(summary).toMatchObject({ archived: 0, failed: 1 });
    expect(notes.failed).toEqual([{ path: RECORD.file, reason: 'could not be moved aside: write-failed' }]);
    expect(Object.keys(stateAfter(files).threads)).toEqual(['AAQkAD-thread']);
    expect(stateAfter(files).retry['AAQkAD-thread']).toEqual({ attempts: 1, reason: 'could not be moved aside: write-failed' });
  });

  // The note moved, so the thread leaves the state, and a file of it that would not move is in no
  // record now: handed on, its move stays owed to the archive.
  it('a file of it that will not move once its note has is handed on, so its move stays owed', async () => {
    const CARD = `kb/Group inboxes/Northwind Leadership Team/threads/${RECORD.folder}/_attachments/a.pdf.md`;
    const handed: string[] = [];
    const files = createFilesFake({
      texts: {
        [STATE_PATH]: serializeGroupState(withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', { ...RECORD, files: [CARD] })),
        [NOTE]: 'note',
        [CARD]: 'card',
      },
    });
    const syncGroup = createSyncGroup({
      reader: createGroupReaderFake({ threads: { '0d3b-group': [thread({ id: 'other', lastDelivered: '2026-07-01T00:00:00Z' })] } }),
      files: { ...files, move: async (from, to) => (from === CARD ? err({ kind: 'write-failed', path: CARD, message: 'locked' }) : files.move(from, to)) },
      logger: createLoggerFake(),
      progress: createProgressFake(),
      clock: createClockFake(),
      kbRoot: 'kb',
      renderThreadFor: () => async () => ok(rendered()),
      writeDown: async (missed) => {
        handed.push(...missed.map((entry) => entry.path));
      },
    });

    const outcome = await syncGroup({ group: GROUP, maxBytes: 50 * 1024 * 1024, dryRun: false, concurrency: 1 });

    expect(outcome.ok).toBe(true);
    expect(files.moves.map((move) => move.from)).toEqual([NOTE]);
    expect(handed).toEqual([CARD]);
  });

  // Held in place, the note keeps the thread and its record, so nothing of it is handed on: the
  // ledger would otherwise move the note of a thread that is still kept.
  it('a thread whose note will not move hands nothing on, and keeps its record', async () => {
    const CARD = `kb/Group inboxes/Northwind Leadership Team/threads/${RECORD.folder}/_attachments/a.pdf.md`;
    const handed: string[] = [];
    const files = createFilesFake({
      texts: {
        [STATE_PATH]: serializeGroupState(withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', { ...RECORD, files: [CARD] })),
        [NOTE]: 'note',
        [CARD]: 'card',
      },
      failMoveWith: { kind: 'write-failed', path: NOTE, message: 'locked' },
    });
    const syncGroup = createSyncGroup({
      reader: createGroupReaderFake({ threads: { '0d3b-group': [thread({ id: 'other', lastDelivered: '2026-07-01T00:00:00Z' })] } }),
      files,
      logger: createLoggerFake(),
      progress: createProgressFake(),
      clock: createClockFake(),
      kbRoot: 'kb',
      renderThreadFor: () => async () => ok(rendered()),
      writeDown: async (missed) => {
        handed.push(...missed.map((entry) => entry.path));
      },
    });

    await syncGroup({ group: GROUP, maxBytes: 50 * 1024 * 1024, dryRun: false, concurrency: 1 });

    expect(handed).toStrictEqual([]);
    expect(Object.keys(stateAfter(files).threads)).toContain('AAQkAD-thread');
  });

  // Out of tries because it could not be written, a thread is still put aside once the group deletes
  // it: putting it aside needs no write.
  it('a thread out of tries because it could not be written is still put aside once the group no longer lists it', async () => {
    const given = serializeGroupState({
      ...withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD),
      retry: { 'AAQkAD-thread': { attempts: 3, reason: 'thread refused' } },
    });
    const { files } = await run({
      files: { texts: { [STATE_PATH]: given, [NOTE]: 'note' } },
      reader: { threads: { '0d3b-group': [thread({ id: 'other', lastDelivered: '2026-07-01T00:00:00Z' })] } },
    });

    expect(files.moves.map((move) => move.from)).toEqual([NOTE]);
  });

  // Out of tries, the thread is named as given up and left where it is.
  it('a thread whose note would not move three runs running is left alone by the fourth', async () => {
    const tried = serializeGroupState({
      ...withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD),
      retry: { 'AAQkAD-thread': { attempts: 3, reason: 'could not be moved aside: write-failed' } },
    });
    const { files } = await run({
      files: { texts: { [STATE_PATH]: tried, [NOTE]: 'note' } },
      reader: { threads: { '0d3b-group': [thread({ id: 'other', lastDelivered: '2026-07-01T00:00:00Z' })] } },
    });

    expect(files.moves).toStrictEqual([]);
    expect(Object.keys(stateAfter(files).threads)).toContain('AAQkAD-thread');
  });

  it('threads the group no longer lists are put aside in the order of their ids, and a thread it still lists stays', async () => {
    const filed = (id: string): ThreadRecord => ({ ...RECORD, folder: `2026-07-20-${id}`, file: `threads/2026-07-20-${id}/note.md` });
    const state = ['zeta', 'alpha'].reduce(
      (carried, id) => withGroupThread(carried, id, filed(id)),
      withGroupThread(emptyGroupState(GROUP.id, GROUP.name), 'AAQkAD-thread', RECORD)
    );
    const notes = {
      'kb/Group inboxes/Northwind Leadership Team/threads/2026-07-20-zeta/note.md': 'z',
      'kb/Group inboxes/Northwind Leadership Team/threads/2026-07-20-alpha/note.md': 'a',
    };
    const swept = await run({ files: { texts: { [STATE_PATH]: serializeGroupState(state), ...notes } } });

    expect(swept.notes.archived.map((entry) => entry.path)).toEqual(['threads/2026-07-20-alpha/note.md', 'threads/2026-07-20-zeta/note.md']);
    expect(Object.keys(stateAfter(swept.files).threads)).toEqual(['AAQkAD-thread']);
  });

  it('a group with no thread at all and nothing on record logs no warning', async () => {
    const { logger } = await run({ reader: { threads: { '0d3b-group': [] } } });

    expect(logger.calls.filter((call) => call.event === 'group.listing-empty')).toStrictEqual([]);
  });

  it('a dry run moves nothing aside', async () => {
    const { files } = await run({ files: { texts: { [STATE_PATH]: held, [NOTE]: 'note' } }, reader: { threads: { '0d3b-group': [thread({ id: 'other' })] } }, dryRun: true });

    expect(files.moves).toStrictEqual([]);
  });
});

describe('naming a group inbox in a report', () => {
  it('a group run names itself a group inbox, so a site of the same name reads apart', async () => {
    const outcome = (): RenderThreadOutcome => rendered({ filesFailed: [{ path: 'budget.xlsx', reason: 'locked' }] });
    const { files } = await run({ outcome });

    expect(files.written.get('kb/Group inboxes/Northwind Leadership Team/_sync-report.md')).toContain(
      '# What did not reach the knowledge base: Northwind Leadership Team (group inbox)'
    );
  });

  it('the run hands the same name back, so the report covering every source reads apart too', async () => {
    const { source } = await run();

    expect(source).toBe('Northwind Leadership Team (group inbox)');
  });
});

describe('a group thread the run could not write', () => {
  const REPORT_PATH = 'kb/Group inboxes/Northwind Leadership Team/_sync-report.md';
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
    expect(askedFor(fourth)).toStrictEqual([]);
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
    expect(askedFor(fourth)).toStrictEqual([]);
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

    expect(dropped.notes.givenUp).toContainEqual({ path: 'thread early', reason: 'thread refused' });
  });

  it('a thread out of tries is named in the report by its topic, under the heading that says it will not be tried again', async () => {
    const second = await again(await swept(), 'early');
    const third = await again(second.files.written.get(STATE_PATH) ?? '', 'early');
    const report = third.files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('Failed 3 times, and will not be tried again unless the file changes:');
    expect(report).toContain('- thread Budget review: thread refused');
    expect(report).not.toContain('will be tried again on the next run');
  });
});

describe('reaching back only as far as the day', () => {
  const NEW = thread();
  const MID = thread({ id: 'mid', topic: 'Spring plans', lastDelivered: '2025-03-01T09:00:00Z' });
  const OLD = thread({ id: 'old', topic: 'Old news', lastDelivered: '2024-01-10T09:00:00Z' });
  const LISTING = { threads: { '0d3b-group': [NEW, MID, OLD] } };
  const filedUnder = (since: string): string => serializeGroupState({ ...withGroupThread(emptyGroupState(GROUP.id, GROUP.name), NEW.id, RECORD), since });

  it('threads last written to before the day are left out', async () => {
    const { asked } = await run({ reader: LISTING, since: '2025-01-01' });

    expect(asked.map((input) => input.root)).toEqual(['mid', 'AAQkAD-thread']);
  });

  it('moving the day earlier files the threads it had left out, and nothing already filed again', async () => {
    const { asked, files } = await run({ files: { texts: { [STATE_PATH]: filedUnder('2025-06-01') } }, reader: LISTING, since: '2025-01-01' });

    expect(asked.map((input) => input.root)).toEqual(['mid']);
    expect(JSON.parse(files.written.get(STATE_PATH) ?? '{}')).toMatchObject({ since: '2025-01-01' });
  });

  // Nothing widened, so the dates are read as always: a thread below the newest one filed was
  // filed already, or had nothing in it to file.
  it('the same day again, or a later one, stops at the newest thread filed', async () => {
    for (const since of ['2025-06-01', '2025-09-01']) {
      const { asked } = await run({ files: { texts: { [STATE_PATH]: filedUnder('2025-06-01') } }, reader: LISTING, since });

      expect(asked).toStrictEqual([]);
    }
  });

  it('reaching everything again files every thread it had left out, and keeps no day', async () => {
    const { asked, files } = await run({ files: { texts: { [STATE_PATH]: filedUnder('2025-06-01') } }, reader: LISTING });

    expect(asked.map((input) => input.root)).toEqual(['old', 'mid']);
    expect('since' in JSON.parse(files.written.get(STATE_PATH) ?? '{}')).toBe(false);
  });

  it('a thread given up on stays given up, even when the day moves earlier', async () => {
    const given = serializeGroupState({
      ...withGroupThread(emptyGroupState(GROUP.id, GROUP.name), NEW.id, RECORD),
      since: '2025-06-01',
      retry: { mid: { attempts: 3, reason: 'thread refused' } },
    });

    const { asked } = await run({ files: { texts: { [STATE_PATH]: given } }, reader: LISTING, since: '2025-01-01' });

    expect(asked.map((input) => input.root)).toStrictEqual([]);
  });
});

// The renderer of a group holds the pictures its run converts, so threads written side by side convert
// a new picture once. Built for each thread, it held nothing for the next one.
describe('the renderer of a group inbox', () => {
  it('is built once for a run of the group, however many threads it writes', async () => {
    const built: string[] = [];
    const syncGroup = createSyncGroup({
      reader: createGroupReaderFake({ threads: { '0d3b-group': [thread(), thread({ id: 'AAQkAD-second', topic: 'Offsite' })] } }),
      files: createFilesFake(),
      logger: createLoggerFake(),
      progress: createProgressFake(),
      clock: createClockFake(),
      kbRoot: 'kb',
      renderThreadFor: (root) => {
        built.push(root);
        return async () => ok(rendered());
      },
    });

    const done = await syncGroup({ group: GROUP, maxBytes: 50 * 1024 * 1024, dryRun: false, concurrency: 2, since: undefined });

    expect(done.ok && done.value.summary.converted).toBe(2);
    expect(built).toStrictEqual(['kb/Group inboxes/Northwind Leadership Team']);
  });
});
