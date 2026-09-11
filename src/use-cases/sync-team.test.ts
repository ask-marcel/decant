import { describe, expect, it } from 'bun:test';
import type { ChannelPost } from '../domain/channel-post.ts';
import { emptyTeamState, serializeTeamState, withChannelCursor, withPost } from '../domain/team-state.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import { createTeamReaderFake } from '../test-helpers/team-reader-fake.ts';
import type { TeamReaderFake, TeamReaderSeed } from '../test-helpers/team-reader-fake.ts';
import type { StepError } from './ports/step-error.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';
import { createSyncTeam } from './sync-team.ts';

const TEAM = { id: 'team-1', name: 'MOOV Leadership' };
const GENERAL = { id: '19:gen@thread.tacv2', name: 'General' };
const PLANNING = { id: '19:plan@thread.tacv2', name: 'Planning' };

const ROOT = 'kb/Teams/MOOV Leadership';
const STATE_PATH = `${ROOT}/.sync-state.json`;

const post = (id: string, lastModified: string, over: Partial<ChannelPost> = {}): ChannelPost => ({
  id,
  subject: `Post ${id}`,
  author: 'Jane Doe',
  created: lastModified,
  lastModified,
  deleted: false,
  webUrl: `https://teams.microsoft.com/l/message/x/${id}`,
  preview: '',
  ...over,
});

const run = async (
  seeds: { reader?: TeamReaderSeed; files?: FilesFakeSeed; channels?: ReadonlyArray<{ id: string; name: string }>; dryRun?: boolean; concurrency?: number } = {}
): Promise<{
  summary: RunSummary;
  source: string;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  progress: ProgressFake;
  reader: TeamReaderFake;
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const reader = createTeamReaderFake({
    posts: { [GENERAL.id]: [post('a', '2026-09-08T09:00:00Z'), post('b', '2026-09-09T09:00:00Z')] },
    deltaLinks: { [GENERAL.id]: 'https://graph/delta?token=next' },
    ...seeds.reader,
  });
  const syncTeam = createSyncTeam({ reader, files, clock: createClockFake('2026-09-11T14:00:00Z'), logger, progress, kbRoot: 'kb' });
  const outcome = await syncTeam({ team: TEAM, channels: seeds.channels ?? [GENERAL], dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 4 });
  const empty = {
    summary: { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 },
    source: TEAM.name,
    notes: { skipped: [], failed: [], givenUp: [], archived: [] },
  };
  return outcome.ok ? { ...outcome.value, files, logger, progress, reader, ok: true } : { ...empty, files, logger, progress, reader, ok: false, error: outcome.error };
};

type StoredState = {
  lastRun: string;
  channels: Record<string, { name: string; deltaLink?: string; posts: Record<string, { file: string; lastModified: string; title: string }> }>;
};

const stateOf = (files: FilesFake): StoredState => JSON.parse(files.written.get(STATE_PATH) ?? '{}');

describe('syncing the channels of a Microsoft Team', () => {
  it('a first run reads each channel whole, writes every post under the day it last changed, and keeps the cursor for next time', async () => {
    const done = await run();

    expect(done.summary.converted).toBe(2);
    expect(done.reader.calls).toContain(`postsDelta:${GENERAL.id}:fresh`);
    expect(done.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/General/2026-09-08/Post a.md`, `${ROOT}/General/2026-09-09/Post b.md`]);
    expect(done.files.written.get(`${ROOT}/General/2026-09-08/Post a.md`)).toContain('### rendered a');
    expect(stateOf(done.files).channels[GENERAL.id]).toMatchObject({
      name: 'General',
      deltaLink: 'https://graph/delta?token=next',
      posts: { a: { file: `${ROOT}/General/2026-09-08/Post a.md`, lastModified: '2026-09-08T09:00:00Z', title: 'Post a' } },
    });
  });

  it('a second run asks each channel only for what changed since its cursor, and leaves an unchanged post alone', async () => {
    const cursored = withChannelCursor(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'https://graph/delta?token=1');
    const state = withPost(cursored, GENERAL.id, GENERAL.name, 'a', { file: `${ROOT}/General/2026-09-08/Post a.md`, lastModified: '2026-09-08T09:00:00Z', title: 'Post a' });
    const done = await run({ files: { texts: { [STATE_PATH]: serializeTeamState(state) } } });

    expect(done.reader.calls).toContain(`postsDelta:${GENERAL.id}:https://graph/delta?token=1`);
    expect(done.reader.calls.filter((call) => call.startsWith('postMarkdown'))).toEqual(['postMarkdown:b']);
    expect(done.summary.converted).toBe(1);
  });

  it('a post replied to since it was written is written again under its new day, and the copy under the old one is put aside', async () => {
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', {
      file: `${ROOT}/General/2026-09-01/Post a.md`,
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Post a',
    });
    const done = await run({ reader: { posts: { [GENERAL.id]: [post('a', '2026-09-08T09:00:00Z')] } }, files: { texts: { [STATE_PATH]: serializeTeamState(state) } } });

    expect(done.summary.converted).toBe(1);
    expect(done.files.moves).toEqual([{ from: `${ROOT}/General/2026-09-01/Post a.md`, to: 'kb/_archive/Teams/MOOV Leadership/General/2026-09-01/Post a.md' }]);
  });

  it('a post deleted in Teams is put aside in the archive and named in the report', async () => {
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', {
      file: `${ROOT}/General/2026-09-01/Post a.md`,
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Post a',
    });
    const done = await run({
      reader: { posts: { [GENERAL.id]: [post('a', '2026-09-10T09:00:00Z', { deleted: true })] } },
      files: { texts: { [STATE_PATH]: serializeTeamState(state) } },
    });

    expect(done.summary.archived).toBe(1);
    expect(done.notes.archived).toEqual([{ path: 'General/Post a', reason: 'deleted in Teams' }]);
    expect(done.files.moves).toEqual([{ from: `${ROOT}/General/2026-09-01/Post a.md`, to: 'kb/_archive/Teams/MOOV Leadership/General/2026-09-01/Post a.md' }]);
    expect(stateOf(done.files).channels[GENERAL.id]?.posts).toEqual({});
    expect(done.files.written.get(`${ROOT}/_sync-report.md`)).toContain('General/Post a');
  });

  it('several channels are each read and written in turn, into folders of their own', async () => {
    const done = await run({
      channels: [GENERAL, PLANNING],
      reader: { posts: { [GENERAL.id]: [post('a', '2026-09-08T09:00:00Z')], [PLANNING.id]: [post('p', '2026-09-08T09:00:00Z')] } },
    });

    expect(done.summary.converted).toBe(2);
    expect(done.files.written.has(`${ROOT}/Planning/2026-09-08/Post p.md`)).toBe(true);
    expect(Object.keys(stateOf(done.files).channels)).toEqual([GENERAL.id, PLANNING.id]);
  });

  it('a post that will not render is reported as failed, and the channel keeps its old cursor so the next run asks for it again', async () => {
    const done = await run({ reader: { failPosts: ['a'] } });

    expect(done.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(done.notes.failed).toEqual([{ path: 'General/Post a', reason: 'cannot render a' }]);
    expect(stateOf(done.files).channels[GENERAL.id]?.deltaLink).toBeUndefined();
    expect(stateOf(done.files).channels[GENERAL.id]?.posts['b']).toBeDefined();
  });

  it('a channel whose delta cannot be read ends the run naming the step', async () => {
    const done = await run({ reader: { failDelta: { kind: 'auth', message: 'sign-in has lapsed' } } });

    expect(done.ok).toBe(false);
    expect(done.error).toEqual({ step: 'postsDelta', cause: 'auth', message: 'sign-in has lapsed' });
  });

  it('a dry run says how many posts it would write and writes nothing at all', async () => {
    const done = await run({ dryRun: true });

    expect(done.summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 2 });
    expect(done.files.writeLog).toHaveLength(0);
  });

  it('a state file this version cannot read is started over rather than written back over', async () => {
    const done = await run({ files: { texts: { [STATE_PATH]: '{"version":99,"source":{"kind":"team","id":"x","name":"y"}}' } } });

    expect(done.summary.converted).toBe(2);
    expect(done.logger.calls.map((entry) => entry.event)).toContain('team-state.unreadable');
  });

  it('a run that found nothing to write still stamps its own state file', async () => {
    const done = await run({ reader: { posts: { [GENERAL.id]: [] } } });

    expect(done.summary.converted).toBe(0);
    expect(stateOf(done.files).lastRun).toBe('2026-09-11T14:00:00Z');
  });

  it('a state file that cannot be saved stops the run', async () => {
    const done = await run({ files: { failWritesMatching: '.sync-state.json' } });

    expect(done.ok).toBe(false);
    expect(done.error?.step).toBe('saveState');
  });

  it('a run with nothing to write still stops when its own state file will not save', async () => {
    const done = await run({ reader: { posts: { [GENERAL.id]: [] } }, files: { failWritesMatching: '.sync-state.json' } });

    expect(done.ok).toBe(false);
    expect(done.error?.step).toBe('saveState');
  });

  it('a team with no channel chosen is refused rather than syncing nothing and calling it done', async () => {
    const done = await run({ channels: [] });

    expect(done.ok).toBe(false);
    expect(done.error).toEqual({ step: 'sync', cause: 'no-channel', message: 'no channel chosen for MOOV Leadership' });
  });
});
