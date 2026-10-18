import { describe, expect, it } from 'bun:test';
import type { ChannelPost } from '../domain/channel-post.ts';
import { freeSegment } from '../domain/kb-path.ts';
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

const TEAM = { id: 'team-1', name: 'Northwind Leadership' };
const GENERAL = { id: '19:gen@thread.tacv2', name: 'General' };
const PLANNING = { id: '19:plan@thread.tacv2', name: 'Planning' };

const ROOT = 'kb/Teams/Northwind Leadership';
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
  seeds: {
    reader?: TeamReaderSeed;
    files?: FilesFakeSeed;
    channels?: ReadonlyArray<{ id: string; name: string }>;
    dryRun?: boolean;
    concurrency?: number;
    since?: string;
    timezone?: string;
  } = {}
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
  const syncTeam = createSyncTeam({ reader, files, clock: createClockFake('2026-09-11T14:00:00Z'), logger, progress, kbRoot: 'kb', timezone: seeds.timezone ?? 'UTC' });
  const outcome = await syncTeam({ team: TEAM, channels: seeds.channels ?? [GENERAL], dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 4, since: seeds.since });
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
    expect(done.files.writeLog.filter((path) => path.endsWith('.md') && !path.endsWith('/_index.md'))).toEqual([
      `${ROOT}/General/2026-09-08/Post a.md`,
      `${ROOT}/General/2026-09-09/Post b.md`,
    ]);
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

  // A reply moves the day a post last changed and not the day it was first posted, so the post keeps
  // its path, and the version before the reply is set aside under the day of the run.
  it('a post replied to since it was written is written again at its own path, and the version before the reply is put aside', async () => {
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', {
      file: `${ROOT}/General/2026-09-01/Post a.md`,
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Post a',
    });
    const replied = post('a', '2026-09-08T09:00:00Z', { created: '2026-09-01T09:00:00Z' });
    const done = await run({
      reader: { posts: { [GENERAL.id]: [replied] } },
      files: { texts: { [STATE_PATH]: serializeTeamState(state), [`${ROOT}/General/2026-09-01/Post a.md`]: 'before the reply' } },
    });

    expect(done.summary.converted).toBe(1);
    expect(done.files.written.get(`${ROOT}/General/2026-09-01/Post a.md`)).toContain('Post a');
    expect(done.files.moves).toEqual([{ from: `${ROOT}/General/2026-09-01/Post a.md`, to: 'kb/_archive/2026-09-11/Teams/Northwind Leadership/General/2026-09-01/Post a.md' }]);
    expect(done.files.written.get('kb/_archive/2026-09-11/Teams/Northwind Leadership/General/2026-09-01/Post a.md')).toBe('before the reply');
  });

  // Written over, the version before the reply would be lost: the post waits for a run that can move it.
  it('a post whose version before will not move aside is not written over, and is tried again on the next run', async () => {
    const FILE = `${ROOT}/General/2026-09-01/Post a.md`;
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', { file: FILE, lastModified: '2026-09-01T09:00:00Z', title: 'Post a' });
    const replied = post('a', '2026-09-08T09:00:00Z', { created: '2026-09-01T09:00:00Z' });
    const done = await run({
      reader: { posts: { [GENERAL.id]: [replied] } },
      files: { texts: { [STATE_PATH]: serializeTeamState(state), [FILE]: 'before the reply' }, failMoveWith: { kind: 'write-failed', path: FILE, message: 'held open' } },
    });
    const kept = JSON.parse(done.files.written.get(STATE_PATH) ?? '{}');

    expect(done.summary).toMatchObject({ converted: 0, failed: 1 });
    expect(done.notes.failed).toEqual([{ path: 'General/Post a', reason: 'its earlier version would not move to _archive/: write-failed' }]);
    expect(done.files.written.get(FILE)).toBe('before the reply');
    expect(kept.channels[GENERAL.id].posts.a.lastModified).toBe('2026-09-01T09:00:00Z');
  });

  // At a new path nothing is written over: the post lands, and the copy left behind is only logged here.
  it('a retitled post whose version before will not move aside is written at its new path all the same', async () => {
    const OLD = `${ROOT}/General/2026-09-01/Post a.md`;
    const NEW = `${ROOT}/General/2026-09-01/Kick-off.md`;
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', { file: OLD, lastModified: '2026-09-01T09:00:00Z', title: 'Post a' });
    const retitled = post('a', '2026-09-08T09:00:00Z', { created: '2026-09-01T09:00:00Z', subject: 'Kick-off' });
    const done = await run({
      reader: { posts: { [GENERAL.id]: [retitled] }, markdown: { a: '### the kick-off is booked' } },
      files: { texts: { [STATE_PATH]: serializeTeamState(state), [OLD]: 'the post as it was' }, failMoveWith: { kind: 'write-failed', path: OLD, message: 'held open' } },
    });

    expect(done.summary).toMatchObject({ converted: 1, failed: 0 });
    expect(done.files.written.get(NEW)).toContain('the kick-off is booked');
    expect(stateOf(done.files).channels[GENERAL.id]?.posts['a']?.file).toBe(NEW);
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: OLD, cause: 'write-failed' } });
  });

  it('a post that will not write puts the version before it back', async () => {
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', {
      file: `${ROOT}/General/2026-09-08/Post a.md`,
      lastModified: 'old',
      title: 'Post a',
    });
    const done = await run({ files: { texts: { [STATE_PATH]: serializeTeamState(state), [`${ROOT}/General/2026-09-08/Post a.md`]: 'before' }, failWritesMatching: 'Post a.md' } });

    expect(done.files.written.get(`${ROOT}/General/2026-09-08/Post a.md`)).toBe('before');
  });

  // Nothing is set aside before the post is read, so a post that will not render moves nothing.
  it('a post that will not render or will not write is logged with its cause, and its version before stays in place', async () => {
    const FILE = `${ROOT}/General/2026-09-08/Post a.md`;
    const held = {
      texts: {
        [STATE_PATH]: serializeTeamState(withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', { file: FILE, lastModified: 'old', title: 'Post a' })),
        [FILE]: 'before',
      },
    };
    const unread = await run({ reader: { failPosts: ['a'] }, files: held });
    const unwritten = await run({ files: { ...held, failWritesMatching: 'Post a.md' } });

    expect(unread.files.moves).toStrictEqual([]);
    expect(unread.files.written.get(FILE)).toBe('before');
    expect(unread.logger.calls).toContainEqual({ level: 'warn', event: 'post.failed', meta: { post: 'a', cause: 'permanent' } });
    expect(unwritten.logger.calls).toContainEqual({ level: 'warn', event: 'post.failed', meta: { post: 'a', cause: 'write-failed' } });
    expect([...unread.logger.calls, ...unwritten.logger.calls].filter((call) => call.level === 'warn' && call.event !== 'post.failed')).toStrictEqual([]);
  });

  // The first layout filed a post under the day it last changed; its id is the moment it was posted.
  it('the first run of this layout moves each post to the day it was first posted, once, and puts nothing aside', async () => {
    const posted = String(Date.parse('2026-09-01T09:00:00Z'));
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, posted, {
      file: `${ROOT}/General/2026-09-08/Kick-off.md`,
      lastModified: '2026-09-08T09:00:00Z',
      title: 'Kick-off',
    });
    const quiet = { posts: { [GENERAL.id]: [] }, deltaLinks: { [GENERAL.id]: 'next' } };
    const first = await run({ reader: quiet, files: { texts: { [STATE_PATH]: serializeTeamState(state), [`${ROOT}/General/2026-09-08/Kick-off.md`]: 'the post' } } });

    expect(first.files.moves).toEqual([{ from: `${ROOT}/General/2026-09-08/Kick-off.md`, to: `${ROOT}/General/2026-09-01/Kick-off.md` }]);
    expect(JSON.parse(first.files.written.get(STATE_PATH) ?? '{}').layout).toBe(2);

    const second = await run({ reader: quiet, files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '' } } });

    expect(second.files.moves).toHaveLength(0);
  });

  it('a post that will not move stays recorded where it is, and the next run moves it', async () => {
    const posted = String(Date.parse('2026-09-01T09:00:00Z'));
    const OLD = `${ROOT}/General/2026-09-08/Kick-off.md`;
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, posted, { file: OLD, lastModified: '2026-09-08T09:00:00Z', title: 'Kick-off' });
    const quiet = { posts: { [GENERAL.id]: [] }, deltaLinks: { [GENERAL.id]: 'next' } };
    const stuck = await run({
      reader: quiet,
      files: { texts: { [STATE_PATH]: serializeTeamState(state), [OLD]: 'the post' }, failMoveWith: { kind: 'write-failed', path: OLD, message: 'locked' } },
    });
    const kept = JSON.parse(stuck.files.written.get(STATE_PATH) ?? '{}');

    expect(kept.channels[GENERAL.id].posts[posted].file).toBe(OLD);
    expect(kept.layout).toBeUndefined();

    const next = await run({ reader: quiet, files: { texts: { [STATE_PATH]: stuck.files.written.get(STATE_PATH) ?? '', [OLD]: 'the post' } } });

    expect(next.files.moves).toEqual([{ from: OLD, to: `${ROOT}/General/2026-09-01/Kick-off.md` }]);
    expect(JSON.parse(next.files.written.get(STATE_PATH) ?? '{}').layout).toBe(2);
  });

  // A file someone took away by hand left its old place already: the move is done, and the layout
  // settles with no failure to warn about.
  it('a post file someone removed does not hold the move to the day it was first posted', async () => {
    const posted = String(Date.parse('2026-09-01T09:00:00Z'));
    const OLD = `${ROOT}/General/2026-09-08/Kick-off.md`;
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, posted, { file: OLD, lastModified: '2026-09-08T09:00:00Z', title: 'Kick-off' });
    const done = await run({ reader: { posts: { [GENERAL.id]: [] }, deltaLinks: { [GENERAL.id]: 'next' } }, files: { texts: { [STATE_PATH]: serializeTeamState(state) } } });
    const kept = JSON.parse(done.files.written.get(STATE_PATH) ?? '{}');

    expect(kept.channels[GENERAL.id].posts[posted].file).toBe(`${ROOT}/General/2026-09-01/Kick-off.md`);
    expect(kept.layout).toBe(2);
    expect(done.logger.calls.filter((call) => call.event === 'refile.failed')).toHaveLength(0);
    expect(done.logger.calls).toContainEqual({ level: 'info', event: 'refile.gone', meta: { path: OLD } });
  });

  // Mail, the calendar and To Do count their days in the zone of the knowledge base, and so do posts.
  it('a post sent just after midnight in the zone of the knowledge base is filed under that day, not the UTC day before', async () => {
    const done = await run({ reader: { posts: { [GENERAL.id]: [post('a', '2026-09-07T22:30:00Z')] } }, timezone: 'Europe/Paris' });

    expect(done.files.written.has(`${ROOT}/General/2026-09-08/Post a.md`)).toBe(true);
  });

  // The page a reader opens the channel by: every post the state holds, the latest activity first.
  it('the channel page lists every post the channel holds, the latest activity first, with who wrote it', async () => {
    const posted = String(Date.parse('2026-09-01T09:00:00Z'));
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, posted, {
      file: `${ROOT}/General/2026-09-01/Kick-off.md`,
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Kick-off',
      from: 'Valerie FAIRBANKS',
    });
    const done = await run({
      reader: { posts: { [GENERAL.id]: [post('a', '2026-09-08T16:00:00Z')] } },
      files: { texts: { [STATE_PATH]: serializeTeamState({ ...state, layout: 2 }) } },
    });

    expect(done.files.written.get(`${ROOT}/General/_index.md`)).toBe(
      [
        '# General',
        '',
        '## By last activity',
        '',
        '- 2026-09-08 · [Post a](<2026-09-08/Post a.md>) · Jane Doe',
        '- 2026-09-01 · [Kick-off](2026-09-01/Kick-off.md) · Valerie FAIRBANKS',
        '',
      ].join('\n')
    );
  });

  it('a channel page that will not write is logged, and the run stands', async () => {
    const done = await run({ files: { failWritesMatching: '_index.md' } });

    expect(done.ok).toBe(true);
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'index.failed', meta: { path: `${ROOT}/General/_index.md`, cause: 'write-failed' } });
  });

  it('a post retitled in the same window as its namesake sets aside only the version each had, and the namesake is rewritten in the file its record names', async () => {
    const retitled = { file: `${ROOT}/General/2026-09-08/Venue.md`, lastModified: '2026-09-08T09:00:00Z', title: 'Venue' };
    // Where the namesake was put while the retitled post held the plain name.
    const namesakeFile = `${ROOT}/General/2026-09-08/${freeSegment('Venue.md', 'namesake', (name) => name === 'Venue.md')}`;
    const namesake = { file: namesakeFile, lastModified: '2026-09-08T10:00:00Z', title: 'Venue' };
    const state = withPost(withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'retitled', retitled), GENERAL.id, GENERAL.name, 'namesake', namesake);
    const done = await run({
      reader: {
        posts: { [GENERAL.id]: [post('retitled', '2026-09-08T16:00:00Z', { subject: 'Catering' }), post('namesake', '2026-09-08T17:00:00Z', { subject: 'Venue' })] },
        markdown: { namesake: '### the venue is booked' },
      },
      files: { texts: { [STATE_PATH]: serializeTeamState(state), [retitled.file]: 'the post as it was', [namesake.file]: 'the namesake as it was' } },
    });

    const recorded = stateOf(done.files).channels[GENERAL.id]?.posts['namesake']?.file ?? '';
    expect(done.files.written.get(recorded)).toContain('the venue is booked');
    expect(done.files.moves).toHaveLength(2);
    expect(done.files.moves).toContainEqual({ from: retitled.file, to: 'kb/_archive/2026-09-11/Teams/Northwind Leadership/General/2026-09-08/Venue.md' });
    expect(done.files.written.get('kb/_archive/2026-09-11/Teams/Northwind Leadership/General/2026-09-08/Venue.md')).toBe('the post as it was');
    expect(done.files.written.get(namesakeFile.replace(`${ROOT}/`, 'kb/_archive/2026-09-11/Teams/Northwind Leadership/'))).toBe('the namesake as it was');
  });

  it('three posts sharing a subject, sent within the same minute, land in three files', async () => {
    const sent = (at: string): ChannelPost => post(String(Date.parse(at)), at, { subject: 'Update' });
    const done = await run({ reader: { posts: { [GENERAL.id]: [sent('2026-09-08T09:00:00Z'), sent('2026-09-08T09:00:20Z'), sent('2026-09-08T09:00:40Z')] } } });

    expect(new Set(Object.values(stateOf(done.files).channels[GENERAL.id]?.posts ?? {}).map((record) => record.file)).size).toBe(3);
  });

  it('a post deleted in Teams is put aside in the archive and named in the report', async () => {
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', {
      file: `${ROOT}/General/2026-09-01/Post a.md`,
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Post a',
    });
    const done = await run({
      reader: { posts: { [GENERAL.id]: [post('a', '2026-09-10T09:00:00Z', { deleted: true })] } },
      files: { texts: { [STATE_PATH]: serializeTeamState(state), [`${ROOT}/General/2026-09-01/Post a.md`]: 'the post' } },
    });

    expect(done.summary.archived).toBe(1);
    expect(done.notes.archived).toEqual([{ path: 'General/Post a', reason: 'deleted in Teams' }]);
    expect(done.files.moves).toEqual([{ from: `${ROOT}/General/2026-09-01/Post a.md`, to: 'kb/_archive/2026-09-11/Teams/Northwind Leadership/General/2026-09-01/Post a.md' }]);
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

  // Three runs on the same version of a post, then it is left alone until it changes: the channel's
  // cursor moves on, and the post no longer costs a read and a report section on every run.
  it('a post that fails three runs running is left alone by the fourth, which moves the cursor on, and is named once in the team report', async () => {
    const failing = async (carried?: Awaited<ReturnType<typeof run>>): ReturnType<typeof run> =>
      run({ reader: { failPosts: ['a'] }, files: { texts: carried === undefined ? {} : { [STATE_PATH]: carried.files.written.get(STATE_PATH) ?? '' } } });
    const third = await failing(await failing(await failing()));
    const fourth = await failing(third);
    const postA = [{ path: 'General/Post a', reason: 'cannot render a' }];

    expect(third.notes.gaveUp).toEqual(postA);
    expect(third.notes.failed).toHaveLength(0);
    expect(third.files.written.get(`${ROOT}/_sync-report.md`)).toContain('Failed 3 times');
    expect(fourth.reader.calls).not.toContain('postMarkdown:a');
    expect(fourth.summary.failed).toBe(0);
    expect(stateOf(fourth.files).channels[GENERAL.id]?.deltaLink).toBe('https://graph/delta?token=next');
    expect(fourth.notes.givenUp).toEqual(postA);
    expect(fourth.notes.gaveUp).toBeUndefined();
    expect(fourth.files.written.has(`${ROOT}/_sync-report.md`)).toBe(false);
  });

  // Given up on, then deleted: nobody can fix it now, and named as failed it would stay in every report.
  it('a post given up on and then deleted in Teams is no longer named as given up', async () => {
    const tries = { attempts: 3, version: '2026-09-08T09:00:00Z', name: 'General/Post a', reason: 'cannot render a' };
    const state = { ...emptyTeamState(TEAM.id, TEAM.name), retry: { a: tries, b: { ...tries, name: 'General/Post b' } } };
    const done = await run({
      reader: { posts: { [GENERAL.id]: [post('a', '2026-09-10T09:00:00Z', { deleted: true }), post('b', '2026-09-08T09:00:00Z')] } },
      files: { texts: { [STATE_PATH]: serializeTeamState(state) } },
    });

    expect(done.notes.givenUp).toEqual([{ path: 'General/Post b', reason: 'cannot render a' }]);
    expect(Object.keys(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').retry)).toEqual(['b']);
  });

  it('a post that renders after a failed run leaves nothing behind to try again', async () => {
    const first = await run({ reader: { failPosts: ['a'] } });
    const second = await run({ files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '' } } });

    expect(JSON.parse(first.files.written.get(STATE_PATH) ?? '{}').retry).toEqual({
      a: { attempts: 1, version: '2026-09-08T09:00:00Z', name: 'General/Post a', reason: 'cannot render a' },
    });
    expect(second.summary.converted).toBe(1);
    expect(JSON.parse(second.files.written.get(STATE_PATH) ?? '{}').retry).toBeUndefined();
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
    expect(done.error).toEqual({ step: 'sync', cause: 'no-channel', message: 'no channel chosen for Northwind Leadership' });
  });
});

describe('reaching back only as far as the day', () => {
  const OLD = post('old', '2024-03-01T09:00:00Z');
  const MID = post('mid', '2025-03-01T09:00:00Z');
  const NEW = post('new', '2026-09-08T09:00:00Z');
  const POSTS = { posts: { [GENERAL.id]: [OLD, MID, NEW] } };
  const cursoredUnder = (since: string): string =>
    serializeTeamState(
      withPost(withChannelCursor(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'https://graph/delta?token=1', since), GENERAL.id, GENERAL.name, 'new', {
        file: `${ROOT}/General/2026-09-08/Post new.md`,
        lastModified: NEW.lastModified,
        title: 'Post new',
      })
    );

  it('posts last changed before the day are left out', async () => {
    const done = await run({ reader: POSTS, since: '2025-01-01' });

    expect(done.files.writeLog.filter((path) => path.endsWith('.md') && !path.endsWith('/_index.md'))).toEqual([
      `${ROOT}/General/2025-03-01/Post mid.md`,
      `${ROOT}/General/2026-09-08/Post new.md`,
    ]);
  });

  it('moving the day earlier reads the channel from the start again, and writes only the posts it had left out', async () => {
    const done = await run({ files: { texts: { [STATE_PATH]: cursoredUnder('2025-06-01') } }, reader: POSTS, since: '2025-01-01' });

    expect(done.reader.calls).toContain(`postsDelta:${GENERAL.id}:fresh`);
    expect(done.files.writeLog.filter((path) => path.endsWith('.md') && !path.endsWith('/_index.md'))).toEqual([`${ROOT}/General/2025-03-01/Post mid.md`]);
    expect(stateOf(done.files).channels[GENERAL.id]).toMatchObject({ deltaLink: 'https://graph/delta?token=next', since: '2025-01-01' });
  });

  it('moving the day earlier reads the old cursor out first, so a post deleted since the last run is still put aside', async () => {
    const done = await run({
      files: { texts: { [STATE_PATH]: cursoredUnder('2025-06-01'), [`${ROOT}/General/2026-09-08/Post new.md`]: 'the post' } },
      reader: { posts: { [GENERAL.id]: [OLD, MID] }, postsFrom: { 'https://graph/delta?token=1': [{ ...NEW, deleted: true }] } },
      since: '2025-01-01',
    });

    expect(done.reader.calls).toEqual([`postsDelta:${GENERAL.id}:https://graph/delta?token=1`, `postsDelta:${GENERAL.id}:fresh`, 'postMarkdown:mid']);
    expect(done.files.moves).toEqual([{ from: `${ROOT}/General/2026-09-08/Post new.md`, to: 'kb/_archive/2026-09-11/Teams/Northwind Leadership/General/2026-09-08/Post new.md' }]);
    expect(done.summary).toMatchObject({ converted: 1, archived: 1 });
  });

  it('the same day, or a later one, keeps following the cursor; all reads the channel again, and keeps no day', async () => {
    for (const since of ['2025-06-01', '2025-09-01']) {
      const kept = await run({ files: { texts: { [STATE_PATH]: cursoredUnder('2025-06-01') } }, reader: POSTS, since });

      expect(kept.reader.calls).toContain(`postsDelta:${GENERAL.id}:https://graph/delta?token=1`);
      expect(kept.reader.calls).not.toContain(`postsDelta:${GENERAL.id}:fresh`);
      expect(stateOf(kept.files).channels[GENERAL.id]).toMatchObject({ since });
      expect(kept.logger.calls.filter((call) => call.level === 'warn')).toStrictEqual([]);
    }

    const everything = await run({ files: { texts: { [STATE_PATH]: cursoredUnder('2025-06-01') } }, reader: POSTS });

    expect(everything.reader.calls).toContain(`postsDelta:${GENERAL.id}:fresh`);
    expect('since' in (stateOf(everything.files).channels[GENERAL.id] ?? {})).toBe(false);
  });

  it('a read that could not write every post keeps the cursor and the day it was taken under, so the next run reads again', async () => {
    const done = await run({ files: { texts: { [STATE_PATH]: cursoredUnder('2025-06-01') }, failWritesMatching: 'Post mid' }, reader: POSTS, since: '2025-01-01' });

    expect(done.summary.failed).toBe(1);
    expect(stateOf(done.files).channels[GENERAL.id]).toMatchObject({ deltaLink: 'https://graph/delta?token=1', since: '2025-06-01' });
  });
});

describe('telling the reader which post is being written', () => {
  it('the counter names each post by its title, never by its id', async () => {
    const done = await run();

    expect([...done.progress.begins].sort((left, right) => left.localeCompare(right))).toEqual(['Post a', 'Post b']);
    expect([...done.progress.steps].sort((left, right) => left.localeCompare(right))).toEqual(['Post a', 'Post b']);
  });
});

// A retitled post no longer holds its earlier file, so a file that would not move is handed on to be
// written down. A post that waits for its earlier file keeps it, and hands on nothing.
describe('handing on the earlier file of a post', () => {
  const OLD = `${ROOT}/General/2026-09-01/Post a.md`;

  const handing = async (subject: string): Promise<ReadonlyArray<string>> => {
    const handed: string[] = [];
    const state = withPost(emptyTeamState(TEAM.id, TEAM.name), GENERAL.id, GENERAL.name, 'a', { file: OLD, lastModified: '2026-09-01T09:00:00Z', title: 'Post a' });
    const files = createFilesFake({
      texts: { [STATE_PATH]: serializeTeamState(state), [OLD]: 'the post as it was' },
      failMoveWith: { kind: 'write-failed', path: OLD, message: 'held open' },
    });
    const reader = createTeamReaderFake({
      posts: { [GENERAL.id]: [post('a', '2026-09-08T09:00:00Z', { created: '2026-09-01T09:00:00Z', subject })] },
      deltaLinks: { [GENERAL.id]: 'next' },
    });
    const writeDown = async (missed: ReadonlyArray<{ readonly path: string }>): Promise<void> => {
      handed.push(...missed.map((entry) => entry.path));
    };
    const syncTeam = createSyncTeam({
      reader,
      files,
      clock: createClockFake('2026-09-11T14:00:00Z'),
      logger: createLoggerFake(),
      progress: createProgressFake(),
      kbRoot: 'kb',
      timezone: 'UTC',
      writeDown,
    });
    await syncTeam({ team: TEAM, channels: [GENERAL], dryRun: false, concurrency: 4 });
    return handed;
  };

  it('a retitled post hands on its earlier file, and one that waits for it hands on nothing', async () => {
    expect(await handing('Kick-off')).toEqual([OLD]);
    expect(await handing('Post a')).toStrictEqual([]);
  });
});
