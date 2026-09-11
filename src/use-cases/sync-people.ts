import { assembleDirectory, renderOrgChart, renderPersonDocument } from '../domain/directory.ts';
import type { Colleague, FileOf } from '../domain/directory.ts';
import { archivePath } from '../domain/output-paths.ts';
import {
  PEOPLE_ID,
  PEOPLE_NAME,
  PEOPLE_STATE_VERSION,
  emptyPeopleState,
  parsePeopleState,
  peopleWorklist,
  planPersonFiles,
  serializePeopleState,
  withPerson,
  withoutPerson,
} from '../domain/people-state.ts';
import type { PeopleState, PersonRecord, PlannedPerson } from '../domain/people-state.ts';
import type { Person } from '../domain/person.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { PeopleReader } from './ports/people-reader.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { TeamReader } from './ports/team-reader.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const PEOPLE_STATE_FILE = '.sync-state.json';

export const ORG_CHART_FILE = '_org-chart.md';

export type SyncPeopleDeps = {
  readonly reader: PeopleReader;
  // The Teams are what the directory is enumerated through, and listing them is the team reader's
  // business already; this needs only that one half of it.
  readonly teams: Pick<TeamReader, 'listTeams'>;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
};

export type SyncPeopleInput = { readonly dryRun: boolean; readonly concurrency: number };

export type SyncPeople = (input: SyncPeopleInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

export const peopleRoot = (kbRoot: string): string => `${kbRoot}/${PEOPLE_NAME}`;

const archiveRootOf = (kbRoot: string): string => `${kbRoot}/_archive/${PEOPLE_NAME}`;

const loadState = async (deps: SyncPeopleDeps, path: string): Promise<PeopleState> => {
  const text = await deps.files.readText(path);
  if (!text.ok) return emptyPeopleState();
  const parsed = parseJson(text.value);
  if (!parsed.ok) return emptyPeopleState();
  const state = parsePeopleState(parsed.value);
  if (state.ok) return state.value;
  deps.logger.warn('people-state.unreadable', { cause: state.error.message });
  return emptyPeopleState();
};

// Everyone the rosters name, by user id: the name the roster gave them, which is what a person who
// then cannot be read is reported under, and the Teams they are in. One record per person rather
// than two maps, so there is no second lookup that could miss.
type Listed = { readonly name: string; readonly teams: ReadonlyArray<string> };

type Rosters = Readonly<Record<string, Listed>>;

const rosters = async (deps: SyncPeopleDeps): Promise<Result<Rosters, StepError>> => {
  const teams = await deps.teams.listTeams();
  if (!teams.ok) return failed('listTeams', teams.error.kind, teams.error.message);
  const listed: Record<string, Listed> = {};
  for (const team of teams.value) {
    const members = await deps.reader.teamMembers(team.id);
    if (!members.ok) return failed('listMembers', members.error.kind, members.error.message);
    for (const member of members.value) listed[member.userId] = { name: member.name, teams: [...(listed[member.userId]?.teams ?? []), team.name] };
  }
  deps.logger.info('people.listed', { teams: teams.value.length, people: Object.keys(listed).length });
  return ok(listed);
};

type Unread = { readonly id: string; readonly name: string; readonly reason: string };

type Profiles = { readonly people: ReadonlyArray<Person>; readonly unread: ReadonlyArray<Unread> };

// One call per person, a window at a time. A profile that cannot be read costs that person and not
// the run: they are reported, kept where they were on disk, and asked for again next time.
const profiles = async (deps: SyncPeopleDeps, input: SyncPeopleInput, listed: Rosters): Promise<Profiles> => {
  const entries = Object.entries(listed);
  const people: Person[] = [];
  const unread: Unread[] = [];
  deps.progress.start(entries.length, PEOPLE_NAME);
  for (let at = 0; at < entries.length; at += input.concurrency) {
    const window = entries.slice(at, at + input.concurrency);
    const answers = await Promise.all(window.map(([id, who]) => deps.reader.profile(id).then((answer) => ({ id, who, answer }))));
    for (const { id, who, answer } of answers) {
      deps.progress.step(who.name);
      if (answer.ok) people.push(answer.value);
      else unread.push({ id, name: who.name, reason: answer.error.message });
    }
  }
  deps.progress.done();
  return { people, unread };
};

const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

// Where a colleague's page is, for the links between pages. Only a colleague has one: a manager
// who has left is named without a link rather than linked to a page about to be put aside.
const filesOf = (planned: ReadonlyArray<PlannedPerson>, directory: ReadonlyArray<Colleague>, state: PeopleState): FileOf => {
  const files = new Map(planned.map((entry) => [entry.colleague.person.id, baseName(entry.file)]));
  for (const colleague of directory) {
    const record = state.people[colleague.person.id];
    if (!files.has(colleague.person.id) && record !== undefined) files.set(colleague.person.id, baseName(record.file));
  }
  return (id) => files.get(id);
};

type Done = { readonly apply: (state: PeopleState) => PeopleState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

const archiveSuperseded = async (deps: SyncPeopleDeps, before: PersonRecord | undefined, after: string): Promise<void> => {
  if (before === undefined || before.file === after) return;
  const moved = await deps.files.move(before.file, archivePath(archiveRootOf(deps.kbRoot), peopleRoot(deps.kbRoot), before.file));
  if (!moved.ok) deps.logger.warn('supersede.failed', { path: before.file, cause: moved.error.kind });
};

const writeOne = async (deps: SyncPeopleDeps, state: PeopleState, planned: PlannedPerson, fileOf: FileOf): Promise<Done> => {
  const { colleague, file } = planned;
  const written = await deps.files.writeText(file, renderPersonDocument({ colleague, fileOf, syncedAt: deps.clock.nowIso() }));
  if (!written.ok) {
    deps.logger.warn('person.failed', { person: colleague.person.id, cause: written.error.kind });
    return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: colleague.person.name, reason: written.error.message }] } };
  }
  await archiveSuperseded(deps, state.people[colleague.person.id], file);
  const record: PersonRecord = { file, name: colleague.person.name, fingerprint: colleague.fingerprint };
  return { apply: (carried) => withPerson(carried, colleague.person.id, record), counted: { converted: 1 }, notes: {} };
};

const archiveGone = async (deps: SyncPeopleDeps, gone: { readonly id: string; readonly record: PersonRecord }): Promise<Done> => {
  const moved = await deps.files.move(gone.record.file, archivePath(archiveRootOf(deps.kbRoot), peopleRoot(deps.kbRoot), gone.record.file));
  if (!moved.ok) deps.logger.warn('archive.failed', { path: gone.record.file, cause: moved.error.kind });
  return { apply: (carried) => withoutPerson(carried, gone.id), counted: { archived: 1 }, notes: { archived: [{ path: gone.record.name, reason: 'no longer in the directory' }] } };
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

type Progressing = { readonly summary: RunSummary; readonly notes: RunNotes; readonly state: PeopleState };

const fold = (carried: Progressing, results: ReadonlyArray<Done>): Progressing => ({
  summary: counted(carried.summary, results),
  notes: noted(carried.notes, results),
  state: results.reduce((state, done) => done.apply(state), carried.state),
});

const save = async (deps: SyncPeopleDeps, state: PeopleState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(`${peopleRoot(deps.kbRoot)}/${PEOPLE_STATE_FILE}`, serializePeopleState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

const writePages = async (
  deps: SyncPeopleDeps,
  input: SyncPeopleInput,
  carried: Progressing,
  planned: ReadonlyArray<PlannedPerson>,
  fileOf: FileOf
): Promise<Result<Progressing, StepError>> => {
  let progressing = carried;
  for (let at = 0; at < planned.length; at += input.concurrency) {
    const results = await Promise.all(planned.slice(at, at + input.concurrency).map((entry) => writeOne(deps, progressing.state, entry, fileOf)));
    progressing = fold(progressing, results);
    const saved = await save(deps, progressing.state);
    if (!saved.ok) return saved;
  }
  return ok(progressing);
};

// The chart is drawn from the whole directory, so it is written again whenever any page was, and
// not otherwise: an unchanged directory leaves it exactly as it was.
const writeOrgChart = async (deps: SyncPeopleDeps, directory: ReadonlyArray<Colleague>, fileOf: FileOf): Promise<void> => {
  const written = await deps.files.writeText(`${peopleRoot(deps.kbRoot)}/${ORG_CHART_FILE}`, renderOrgChart(directory, fileOf));
  if (!written.ok) deps.logger.warn('org-chart.failed', { cause: written.error.kind });
};

const finish = async (deps: SyncPeopleDeps, input: SyncPeopleInput, done: Progressing): Promise<Result<SourceRun, StepError>> => {
  const saved = await save(deps, done.state);
  if (!saved.ok) return saved;
  await writeReport(deps, input, peopleRoot(deps.kbRoot), PEOPLE_NAME, done.summary, done.notes);
  return ok({ id: PEOPLE_ID, source: PEOPLE_NAME, summary: done.summary, notes: done.notes });
};

export const createSyncPeople =
  (deps: SyncPeopleDeps): SyncPeople =>
  async (input) => {
    const state: PeopleState = { ...(await loadState(deps, `${peopleRoot(deps.kbRoot)}/${PEOPLE_STATE_FILE}`)), version: PEOPLE_STATE_VERSION };
    const listed = await rosters(deps);
    if (!listed.ok) return listed;
    const read = await profiles(deps, input, listed.value);
    const directory = assembleDirectory(read.people, Object.fromEntries(Object.entries(listed.value).map(([id, who]) => [id, who.teams])));
    const work = peopleWorklist(
      state,
      directory,
      read.unread.map((entry) => entry.id)
    );
    if (input.dryRun) return ok({ id: PEOPLE_ID, source: PEOPLE_NAME, summary: { ...EMPTY, queued: work.write.length }, notes: NO_NOTES });
    const planned = planPersonFiles(peopleRoot(deps.kbRoot), work.write, state);
    const fileOf = filesOf(planned, directory, state);
    const unread: RunNotes = { ...NO_NOTES, failed: read.unread.map((entry) => ({ path: entry.name, reason: entry.reason })) };
    const written = await writePages(deps, input, { summary: { ...EMPTY, failed: read.unread.length }, notes: unread, state }, planned, fileOf);
    if (!written.ok) return written;
    const done = fold(written.value, await Promise.all(work.archive.map((entry) => archiveGone(deps, entry))));
    if (work.write.length + work.archive.length > 0) await writeOrgChart(deps, directory, fileOf);
    return finish(deps, input, done);
  };
