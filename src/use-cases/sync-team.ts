import { renderPostDocument } from '../domain/channel-document.ts';
import { safeSegment } from '../domain/kb-path.ts';
import { archivePath } from '../domain/output-paths.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import {
  TEAM_STATE_VERSION,
  channelWork,
  emptyTeamState,
  parseTeamState,
  planPostFiles,
  serializeTeamState,
  teamRootName,
  withChannelCursor,
  withPost,
  withoutPost,
} from '../domain/team-state.ts';
import type { PlannedPost, PostRecord, TeamState } from '../domain/team-state.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { ChannelSummary, TeamReader, TeamSummary } from './ports/team-reader.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const TEAM_STATE_FILE = '.sync-state.json';

export type SyncTeamDeps = {
  readonly reader: TeamReader;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
};

// A team is synced channel by channel, the way a site is synced library by library, and for the
// same reason: each channel keeps its own cursor, so one that fails costs itself and not the rest.
export type SyncTeamInput = { readonly team: TeamSummary; readonly channels: ReadonlyArray<ChannelSummary>; readonly dryRun: boolean; readonly concurrency: number };

export type SyncTeam = (input: SyncTeamInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

export const teamRoot = (kbRoot: string, name: string): string => `${kbRoot}/${teamRootName(name)}`;

type Roots = { readonly root: string; readonly archive: string };

// A channel's own folder under the team, and its mirror under `_archive/`.
const channelRoots = (deps: SyncTeamDeps, team: TeamSummary, channel: ChannelSummary): Roots => ({
  root: `${teamRoot(deps.kbRoot, team.name)}/${safeSegment(channel.name)}`,
  archive: `${deps.kbRoot}/_archive/${teamRootName(team.name)}/${safeSegment(channel.name)}`,
});

const loadState = async (deps: SyncTeamDeps, path: string, team: TeamSummary): Promise<TeamState> => {
  const text = await deps.files.readText(path);
  if (!text.ok) return emptyTeamState(team.id, team.name);
  const parsed = parseJson(text.value);
  if (!parsed.ok) return emptyTeamState(team.id, team.name);
  const state = parseTeamState(parsed.value);
  if (state.ok) return state.value;
  // Left where it is and started over in memory, never written back over: the documents on disk are
  // the valuable half, and a run that cannot read its own notes should re-file them rather than
  // delete what it cannot account for.
  deps.logger.warn('team-state.unreadable', { team: team.id, cause: state.error.message });
  return emptyTeamState(team.id, team.name);
};

type Done = { readonly apply: (state: TeamState) => TeamState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

// Named for the report as `<channel>/<title>`: a post is found by its channel first, and a title
// alone would leave two channels' posts indistinguishable in one list.
const reportName = (channel: ChannelSummary, title: string): string => `${channel.name}/${title}`;

// The copy under the day the post used to carry, which the fresh one does not overwrite because it
// sits under a different day. Put aside rather than deleted.
const archiveSuperseded = async (deps: SyncTeamDeps, roots: Roots, before: PostRecord | undefined, after: string): Promise<void> => {
  if (before === undefined || before.file === after) return;
  const moved = await deps.files.move(before.file, archivePath(roots.archive, roots.root, before.file));
  if (!moved.ok) deps.logger.warn('supersede.failed', { path: before.file, cause: moved.error.kind });
};

type ChannelContext = { readonly deps: SyncTeamDeps; readonly input: SyncTeamInput; readonly channel: ChannelSummary; readonly roots: Roots };

const writeOne = async (context: ChannelContext, state: TeamState, planned: PlannedPost): Promise<Done> => {
  const { deps, input, channel } = context;
  const { post, file } = planned;
  const title = file.slice(file.lastIndexOf('/') + 1, -'.md'.length);
  const markdown = await deps.reader.postMarkdown(input.team.id, channel.id, post.id);
  const written = markdown.ok
    ? await deps.files.writeText(file, renderPostDocument({ post, team: input.team.name, channel: channel.name, markdown: markdown.value, syncedAt: deps.clock.nowIso() }))
    : markdown;
  if (!written.ok) {
    deps.logger.warn('post.failed', { post: post.id, cause: written.error.kind });
    return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: reportName(channel, title), reason: written.error.message }] } };
  }
  await archiveSuperseded(deps, context.roots, state.channels[channel.id]?.posts[post.id], file);
  const record: PostRecord = { file, lastModified: post.lastModified, title };
  return { apply: (carried) => withPost(carried, channel.id, channel.name, post.id, record), counted: { converted: 1 }, notes: {} };
};

const archiveGone = async (context: ChannelContext, gone: { readonly id: string; readonly record: PostRecord }): Promise<Done> => {
  const { deps, channel, roots } = context;
  const moved = await deps.files.move(gone.record.file, archivePath(roots.archive, roots.root, gone.record.file));
  if (!moved.ok) deps.logger.warn('archive.failed', { path: gone.record.file, cause: moved.error.kind });
  return {
    apply: (carried) => withoutPost(carried, channel.id, gone.id),
    counted: { archived: 1 },
    notes: { archived: [{ path: reportName(channel, gone.record.title), reason: 'deleted in Teams' }] },
  };
};

const counted = (summary: RunSummary, results: ReadonlyArray<Done>): RunSummary =>
  results.reduce(
    (carried, done) => ({
      ...carried,
      converted: carried.converted + (done.counted.converted ?? 0),
      archived: carried.archived + (done.counted.archived ?? 0),
      failed: carried.failed + (done.counted.failed ?? 0),
    }),
    summary
  );

const noted = (notes: RunNotes, results: ReadonlyArray<Done>): RunNotes => ({
  ...notes,
  failed: [...notes.failed, ...results.flatMap((done) => done.notes.failed ?? [])],
  archived: [...notes.archived, ...results.flatMap((done) => done.notes.archived ?? [])],
});

type Progressing = { readonly summary: RunSummary; readonly notes: RunNotes; readonly state: TeamState };

const fold = (carried: Progressing, results: ReadonlyArray<Done>): Progressing => ({
  summary: counted(carried.summary, results),
  notes: noted(carried.notes, results),
  state: results.reduce((state, done) => done.apply(state), carried.state),
});

const save = async (deps: SyncTeamDeps, input: SyncTeamInput, state: TeamState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(`${teamRoot(deps.kbRoot, input.team.name)}/${TEAM_STATE_FILE}`, serializeTeamState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

const writeWindow = async (context: ChannelContext, state: TeamState, window: ReadonlyArray<PlannedPost>): Promise<ReadonlyArray<Done>> =>
  Promise.all(
    window.map((planned) => {
      context.deps.progress.begin(planned.post.id);
      return writeOne(context, state, planned).then((done) => {
        context.deps.progress.step(planned.post.id);
        return done;
      });
    })
  );

const writePosts = async (context: ChannelContext, carried: Progressing, planned: ReadonlyArray<PlannedPost>): Promise<Result<Progressing, StepError>> => {
  let progressing = carried;
  for (let at = 0; at < planned.length; at += context.input.concurrency) {
    const results = await writeWindow(context, progressing.state, planned.slice(at, at + context.input.concurrency));
    progressing = fold(progressing, results);
    const saved = await save(context.deps, context.input, progressing.state);
    if (!saved.ok) return saved;
  }
  return ok(progressing);
};

// The cursor moves only once every post the delta reported has landed. A post that failed to
// render is not in the ledger, so a cursor that moved past it would never ask for it again; kept
// where it was, the next run re-reads the delta, skips by `lastModified` what already landed, and
// tries the one that did not once more. A post that never renders keeps its channel re-reading
// the delta every run, and the report names it every run, which is the honest price.
const cursorAfter = (before: Progressing, after: Progressing, deltaLink: string | undefined): string | undefined =>
  after.summary.failed > before.summary.failed ? undefined : deltaLink;

const syncChannel = async (deps: SyncTeamDeps, input: SyncTeamInput, carried: Progressing, channel: ChannelSummary): Promise<Result<Progressing, StepError>> => {
  const context: ChannelContext = { deps, input, channel, roots: channelRoots(deps, input.team, channel) };
  const delta = await deps.reader.postsDelta(input.team.id, channel.id, carried.state.channels[channel.id]?.deltaLink);
  if (!delta.ok) return failed('postsDelta', delta.error.kind, delta.error.message);
  const work = channelWork(carried.state, channel.id, delta.value.posts);
  if (input.dryRun) return ok({ ...carried, summary: { ...carried.summary, queued: carried.summary.queued + work.write.length } });
  deps.progress.start(work.write.length, `${input.team.name} / ${channel.name}`);
  const written = await writePosts(context, carried, planPostFiles(context.roots.root, work.write, carried.state, channel.id));
  deps.progress.done();
  if (!written.ok) return written;
  const gone = await Promise.all(work.archive.map((entry) => archiveGone(context, entry)));
  const done = fold(written.value, gone);
  return ok({ ...done, state: withChannelCursor(done.state, channel.id, channel.name, cursorAfter(carried, done, delta.value.deltaLink)) });
};

const syncChannels = async (deps: SyncTeamDeps, input: SyncTeamInput, state: TeamState): Promise<Result<Progressing, StepError>> => {
  let progressing: Progressing = { summary: EMPTY, notes: NO_NOTES, state };
  for (const channel of input.channels) {
    const synced = await syncChannel(deps, input, progressing, channel);
    if (!synced.ok) return synced;
    progressing = synced.value;
  }
  return ok(progressing);
};

export const createSyncTeam =
  (deps: SyncTeamDeps): SyncTeam =>
  async (input) => {
    if (input.channels.length === 0) return failed('sync', 'no-channel', `no channel chosen for ${input.team.name}`);
    const state = await loadState(deps, `${teamRoot(deps.kbRoot, input.team.name)}/${TEAM_STATE_FILE}`, input.team);
    const done = await syncChannels(deps, input, { ...state, version: TEAM_STATE_VERSION });
    if (!done.ok) return done;
    if (input.dryRun) return ok({ id: input.team.id, source: input.team.name, summary: done.value.summary, notes: NO_NOTES });
    // Saved once at the end as well as per window, so a run that found nothing to write still
    // stamps its own file rather than carrying the date of the last run that found work.
    const saved = await save(deps, input, done.value.state);
    if (!saved.ok) return saved;
    await writeReport(deps, input, teamRoot(deps.kbRoot, input.team.name), input.team.name, done.value.summary, done.value.notes);
    return ok({ id: input.team.id, source: input.team.name, summary: done.value.summary, notes: done.value.notes });
  };
