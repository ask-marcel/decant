import { assembleDirectory, renderOrgChart, renderPersonDocument } from '../domain/directory.ts';
import type { Colleague, FileOf } from '../domain/directory.ts';
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
import { clearAttempt, gaveUpNotes, givenUpNotes, heldAttempts, isGivenUp, nextAttempt, recordAttempt, triedReads } from '../domain/retry-ledger.ts';
import { withGaveUp } from '../domain/report.ts';
import type { Unread } from '../domain/retry-ledger.ts';
import { putAside } from './put-aside.ts';
import type { WriteDown } from './put-aside.ts';

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
  // How long a path may be as decant writes it: Windows' limit less what stands in front of the
  // knowledge base on disk. Absent, names are not cut for length.
  readonly pathBudget?: number;
  // Where the files this sync lets go that would not move under the archive are written down, so a
  // later run moves them. Absent, such a file is only logged.
  readonly writeDown?: WriteDown;
};

export type SyncPeopleInput = { readonly dryRun: boolean; readonly concurrency: number };

export type SyncPeople = (input: SyncPeopleInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

export const peopleRoot = (kbRoot: string): string => `${kbRoot}/${PEOPLE_NAME}`;

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

// Rosters that name nobody while people are on record are a Graph answer gone wrong, a lost permission
// most often, not a directory emptied in a day: the run stops before it puts every page aside.
const emptyRosters = (state: PeopleState, listed: Rosters): Result<never, StepError> | undefined => {
  const held = Object.keys(state.people).length;
  if (Object.keys(listed).length > 0 || held === 0) return undefined;
  return failed(
    'listMembers',
    'empty',
    `the Team rosters name nobody, and ${held} ${held === 1 ? 'person is' : 'people are'} on record: nothing was put aside. Check that the account can still read its Teams`
  );
};

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

// Where a colleague's page is, for the links between pages. Only a colleague has one, and a person
// whose profile would not read this run, whose page stays: a manager who has left is named without a
// link rather than linked to a page about to be put aside.
const filesOf = (planned: ReadonlyArray<PlannedPerson>, directory: ReadonlyArray<Colleague>, state: PeopleState, kept: ReadonlySet<string>): FileOf => {
  const files = new Map(planned.map((entry) => [entry.colleague.person.id, baseName(entry.file)]));
  for (const id of [...directory.map((colleague) => colleague.person.id), ...kept]) {
    const record = state.people[id];
    if (!files.has(id) && record !== undefined) files.set(id, baseName(record.file));
  }
  return (id) => files.get(id);
};

type Done = { readonly apply: (state: PeopleState) => PeopleState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

const archiveSuperseded = async (deps: SyncPeopleDeps, before: PersonRecord | undefined, after: string): Promise<void> => {
  if (before === undefined || before.file === after) return;
  for (const missed of await putAside(deps, [before.file])) deps.logger.warn('supersede.failed', { path: missed.path, cause: missed.error.kind });
};

const writeOne = async (deps: SyncPeopleDeps, state: PeopleState, planned: PlannedPerson, fileOf: FileOf): Promise<Done> => {
  const { colleague, file } = planned;
  const written = await deps.files.writeText(file, renderPersonDocument({ colleague, fileOf, syncedAt: deps.clock.nowIso() }));
  const id = colleague.person.id;
  if (!written.ok) {
    deps.logger.warn('person.failed', { person: id, cause: written.error.kind });
    const attempt = nextAttempt(state.retry?.[id], colleague.fingerprint, colleague.person.name, written.error.message);
    // Out of tries now: named under its own heading, not as a failure the next run will try again.
    const notes = isGivenUp(attempt, colleague.fingerprint) ? {} : { failed: [{ path: colleague.person.name, reason: written.error.message }] };
    return { apply: (carried) => ({ ...carried, retry: recordAttempt(carried.retry, id, attempt) }), counted: { failed: 1 }, notes };
  }
  await archiveSuperseded(deps, state.people[id], file);
  const record: PersonRecord = { file, name: colleague.person.name, fingerprint: colleague.fingerprint };
  return { apply: (carried) => ({ ...withPerson(carried, id, record), retry: clearAttempt(carried.retry, id) }), counted: { converted: 1 }, notes: {} };
};

const archiveGone = async (deps: SyncPeopleDeps, gone: { readonly id: string; readonly record: PersonRecord }): Promise<Done> => {
  for (const missed of await putAside(deps, [gone.record.file])) deps.logger.warn('archive.failed', { path: missed.path, cause: missed.error.kind });
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

const finish = async (deps: SyncPeopleDeps, input: SyncPeopleInput, before: PeopleState, done: Progressing): Promise<Result<SourceRun, StepError>> => {
  const saved = await save(deps, done.state);
  if (!saved.ok) return saved;
  const notes = withGaveUp({ ...done.notes, givenUp: givenUpNotes(done.state.retry) }, gaveUpNotes(before.retry, done.state.retry));
  await writeReport(deps, input, peopleRoot(deps.kbRoot), PEOPLE_NAME, done.summary, notes);
  return ok({ id: PEOPLE_ID, source: PEOPLE_NAME, summary: done.summary, notes });
};

export const createSyncPeople =
  (deps: SyncPeopleDeps): SyncPeople =>
  async (input) => {
    const state: PeopleState = { ...(await loadState(deps, `${peopleRoot(deps.kbRoot)}/${PEOPLE_STATE_FILE}`)), version: PEOPLE_STATE_VERSION };
    const listed = await rosters(deps);
    if (!listed.ok) return listed;
    const nobody = emptyRosters(state, listed.value);
    if (nobody !== undefined) return nobody;
    const read = await profiles(deps, input, listed.value);
    // A person whose profile would not read keeps the page on record, and so does the link to it.
    const kept = new Set(read.unread.map((entry) => entry.id).filter((id) => state.people[id] !== undefined));
    const directory = assembleDirectory(read.people, Object.fromEntries(Object.entries(listed.value).map(([id, who]) => [id, who.teams])), kept);
    const work = peopleWorklist(
      state,
      directory,
      read.unread.map((entry) => entry.id)
    );
    if (input.dryRun) return ok({ id: PEOPLE_ID, source: PEOPLE_NAME, summary: { ...EMPTY, queued: work.write.length }, notes: NO_NOTES });
    const planned = planPersonFiles(peopleRoot(deps.kbRoot), work.write, state, deps.pathBudget);
    const fileOf = filesOf(planned, directory, state, kept);
    // Every profile is read on every run, since the rosters are read whole: one Graph will not hand
    // over is named as a failure for three runs, then given up on.
    const tried = triedReads(
      state.retry,
      read.people.map((person) => person.id),
      read.unread
    );
    const unread: RunNotes = { ...NO_NOTES, failed: tried.failed };
    const written = await writePages(deps, input, { summary: { ...EMPTY, failed: tried.tried }, notes: unread, state: { ...state, retry: tried.retry } }, planned, fileOf);
    if (!written.ok) return written;
    const folded = fold(written.value, await Promise.all(work.archive.map((entry) => archiveGone(deps, entry))));
    // Whoever left every roster leaves the ledger too: given up on, they would be named in every report.
    const done = { ...folded, state: { ...folded.state, retry: heldAttempts(folded.state.retry, new Set(Object.keys(listed.value))) } };
    if (work.write.length + work.archive.length > 0) await writeOrgChart(deps, directory, fileOf);
    return finish(deps, input, state, done);
  };
