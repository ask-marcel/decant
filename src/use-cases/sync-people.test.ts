import { describe, expect, it } from 'bun:test';
import { assembleDirectory } from '../domain/directory.ts';
import { emptyPeopleState, serializePeopleState, withPerson } from '../domain/people-state.ts';
import type { Person } from '../domain/person.ts';
import { ok } from '../domain/result.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createPeopleReaderFake } from '../test-helpers/people-reader-fake.ts';
import type { PeopleReaderFake, PeopleReaderSeed } from '../test-helpers/people-reader-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import type { StepError } from './ports/step-error.ts';
import type { TeamSummary } from './ports/team-reader.ts';
import { createSyncPeople } from './sync-people.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

const ROOT = 'kb/People';
const STATE_PATH = `${ROOT}/.sync-state.json`;

const person = (id: string, name: string, over: Partial<Person> = {}): Person => ({
  id,
  name,
  title: '',
  department: '',
  email: `${id}@example.com`,
  phones: [],
  office: '',
  enabled: true,
  member: true,
  manager: undefined,
  ...over,
});

const DANA = person('dana', 'Dana Farrow', { title: 'CEO' });
const JANE = person('jane', 'Jane Doe', { title: 'Head of Operations', manager: { id: 'dana', name: 'Dana Farrow' } });
const GUEST = person('guest', 'Outside Consultant', { member: false });

const ALL = { id: 'team-all', name: 'NORTHWIND EMPLOYEES' };
const LEAD = { id: 'team-lead', name: 'Leadership' };

const ROSTERS = {
  'team-all': [
    { userId: 'dana', name: 'Dana Farrow' },
    { userId: 'jane', name: 'Jane Doe' },
    { userId: 'guest', name: 'Outside Consultant' },
  ],
  'team-lead': [
    { userId: 'dana', name: 'Dana Farrow' },
    { userId: 'jane', name: 'Jane Doe' },
  ],
};

const PROFILES = { dana: DANA, jane: JANE, guest: GUEST };

const run = async (
  seeds: { reader?: PeopleReaderSeed; files?: FilesFakeSeed; teams?: ReadonlyArray<TeamSummary>; failTeams?: StepError; dryRun?: boolean; concurrency?: number } = {}
): Promise<{
  summary: RunSummary;
  source: string;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  reader: PeopleReaderFake;
  progress: ProgressFake;
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const reader = createPeopleReaderFake({ members: ROSTERS, profiles: PROFILES, ...seeds.reader });
  const syncPeople = createSyncPeople({
    reader,
    teams: { listTeams: async () => (seeds.failTeams === undefined ? ok(seeds.teams ?? [ALL, LEAD]) : { ok: false, error: { kind: 'auth', message: seeds.failTeams.message } }) },
    files,
    clock: createClockFake('2026-09-11T14:00:00Z'),
    logger,
    progress,
    kbRoot: 'kb',
  });
  const outcome = await syncPeople({ dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 4 });
  const empty = {
    summary: { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 },
    source: 'People',
    notes: { skipped: [], failed: [], givenUp: [], archived: [] },
  };
  return outcome.ok ? { ...outcome.value, files, logger, reader, progress, ok: true } : { ...empty, files, logger, reader, progress, ok: false, error: outcome.error };
};

const stateOf = (files: FilesFake): { lastRun: string; people: Record<string, { file: string; name: string; fingerprint: string }> } =>
  JSON.parse(files.written.get(STATE_PATH) ?? '{}');

const fingerprintOf = (id: string, people: ReadonlyArray<Person>, teams: Record<string, ReadonlyArray<string>>): string =>
  assembleDirectory(people, teams).find((entry) => entry.person.id === id)?.fingerprint ?? '';

describe('syncing the people directory', () => {
  it('a first run reads every Team roster, one profile per person, and writes a page per colleague and the org chart', async () => {
    const done = await run();

    expect(done.summary.converted).toBe(2);
    expect(done.reader.calls.filter((call) => call.startsWith('profile:')).toSorted((left, right) => left.localeCompare(right))).toEqual([
      'profile:dana',
      'profile:guest',
      'profile:jane',
    ]);
    expect(new Set(done.files.written.keys())).toEqual(new Set([`${ROOT}/.sync-state.json`, `${ROOT}/Dana Farrow.md`, `${ROOT}/Jane Doe.md`, `${ROOT}/_org-chart.md`]));
    expect(done.files.written.get(`${ROOT}/Jane Doe.md`)).toContain('Reports to [Dana Farrow](<Dana Farrow.md>)');
    expect(done.files.written.get(`${ROOT}/Jane Doe.md`)).toContain('teams:\n  - Leadership\n  - NORTHWIND EMPLOYEES');
    expect(done.files.written.get(`${ROOT}/_org-chart.md`)).toContain('- [Dana Farrow](<Dana Farrow.md>), CEO\n  - [Jane Doe](<Jane Doe.md>), Head of Operations');
    expect(stateOf(done.files).people['jane']).toMatchObject({ file: `${ROOT}/Jane Doe.md`, name: 'Jane Doe' });
  });

  it('a guest is read and left out, and never counted as anyone`s report', async () => {
    const done = await run();

    expect(done.files.written.has(`${ROOT}/Outside Consultant.md`)).toBe(false);
    expect(done.files.written.get(`${ROOT}/Dana Farrow.md`)).not.toContain('Outside Consultant');
  });

  it('a second run reads every profile again and writes only the people whose profile changed', async () => {
    const teams = { dana: ['NORTHWIND EMPLOYEES', 'Leadership'], jane: ['NORTHWIND EMPLOYEES', 'Leadership'] };
    const state = withPerson(
      withPerson(emptyPeopleState(), 'dana', { file: `${ROOT}/Dana Farrow.md`, name: 'Dana Farrow', fingerprint: fingerprintOf('dana', [DANA, JANE], teams) }),
      'jane',
      { file: `${ROOT}/Jane Doe.md`, name: 'Jane Doe', fingerprint: 'stale' }
    );
    const done = await run({ files: { texts: { [STATE_PATH]: serializePeopleState(state) } } });

    expect(done.reader.calls.filter((call) => call.startsWith('profile:'))).toHaveLength(3);
    expect(done.summary.converted).toBe(1);
    expect(done.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/Jane Doe.md`, `${ROOT}/_org-chart.md`]);
    expect(done.files.written.get(`${ROOT}/Jane Doe.md`)).toContain('Reports to [Dana Farrow](<Dana Farrow.md>)');
  });

  it('a run where nobody changed writes nothing but its own state file', async () => {
    const teams = { dana: ['NORTHWIND EMPLOYEES', 'Leadership'], jane: ['NORTHWIND EMPLOYEES', 'Leadership'] };
    const state = withPerson(
      withPerson(emptyPeopleState(), 'dana', { file: `${ROOT}/Dana Farrow.md`, name: 'Dana Farrow', fingerprint: fingerprintOf('dana', [DANA, JANE], teams) }),
      'jane',
      { file: `${ROOT}/Jane Doe.md`, name: 'Jane Doe', fingerprint: fingerprintOf('jane', [DANA, JANE], teams) }
    );
    const done = await run({ files: { texts: { [STATE_PATH]: serializePeopleState(state) } } });

    expect(done.summary.converted).toBe(0);
    expect(done.files.writeLog).toEqual([STATE_PATH]);
    expect(stateOf(done.files).lastRun).toBe('2026-09-11T14:00:00Z');
  });

  it('a person who has left every Team, or whose account is disabled, is put aside in the archive and named in the report', async () => {
    const state = withPerson(withPerson(emptyPeopleState(), 'gone', { file: `${ROOT}/Left Already.md`, name: 'Left Already', fingerprint: 'x' }), 'off', {
      file: `${ROOT}/Switched Off.md`,
      name: 'Switched Off',
      fingerprint: 'y',
    });
    const rosters = { 'team-all': [...ROSTERS['team-all'], { userId: 'off', name: 'Switched Off' }], 'team-lead': ROSTERS['team-lead'] };
    const done = await run({
      reader: { members: rosters, profiles: { ...PROFILES, off: person('off', 'Switched Off', { enabled: false }) } },
      files: { texts: { [STATE_PATH]: serializePeopleState(state) } },
    });

    expect(done.summary.archived).toBe(2);
    expect(done.notes.archived).toEqual([
      { path: 'Left Already', reason: 'no longer in the directory' },
      { path: 'Switched Off', reason: 'no longer in the directory' },
    ]);
    expect(done.files.moves.map((move) => move.to)).toEqual(['kb/_archive/People/Left Already.md', 'kb/_archive/People/Switched Off.md']);
    expect(Object.keys(stateOf(done.files).people).toSorted((left, right) => left.localeCompare(right))).toEqual(['dana', 'jane']);
  });

  it('a person whose name changed is written under the new name, and the page under the old one is put aside', async () => {
    const state = withPerson(emptyPeopleState(), 'jane', { file: `${ROOT}/Jane Smith.md`, name: 'Jane Smith', fingerprint: 'old' });
    const done = await run({ files: { texts: { [STATE_PATH]: serializePeopleState(state) } } });

    expect(done.files.written.has(`${ROOT}/Jane Doe.md`)).toBe(true);
    expect(done.files.moves).toEqual([{ from: `${ROOT}/Jane Smith.md`, to: 'kb/_archive/People/Jane Smith.md' }]);
  });

  it('a person renamed in the same run as a namesake puts only their own old page aside, and the namesake is rewritten in the page their record names', async () => {
    const state = withPerson(withPerson(emptyPeopleState(), 'jane', { file: `${ROOT}/Jane Doe.md`, name: 'Jane Doe', fingerprint: 'stale' }), 'jane-b', {
      file: `${ROOT}/Jane Doe-jane-b.md`,
      name: 'Jane Doe',
      fingerprint: 'stale',
    });
    const done = await run({
      reader: {
        members: {
          'team-all': [
            { userId: 'jane', name: 'Jane Smith' },
            { userId: 'jane-b', name: 'Jane Doe' },
          ],
        },
        profiles: { jane: person('jane', 'Jane Smith'), 'jane-b': person('jane-b', 'Jane Doe', { title: 'Head of Finance' }) },
      },
      files: { texts: { [STATE_PATH]: serializePeopleState(state), [`${ROOT}/Jane Doe.md`]: 'the page as it was', [`${ROOT}/Jane Doe-jane-b.md`]: 'the namesake as it was' } },
    });

    const recorded = stateOf(done.files).people['jane-b']?.file ?? '';
    expect(done.files.written.get(recorded)).toContain('Head of Finance');
    expect(done.files.moves).toEqual([{ from: `${ROOT}/Jane Doe.md`, to: 'kb/_archive/People/Jane Doe.md' }]);
    expect(done.files.written.get('kb/_archive/People/Jane Doe.md')).toBe('the page as it was');
  });

  it('a profile that cannot be read is reported as failed, and that person is neither written nor put aside', async () => {
    const state = withPerson(emptyPeopleState(), 'jane', { file: `${ROOT}/Jane Doe.md`, name: 'Jane Doe', fingerprint: 'whatever' });
    const done = await run({ reader: { failProfiles: ['jane'] }, files: { texts: { [STATE_PATH]: serializePeopleState(state) } } });

    expect(done.summary).toMatchObject({ converted: 1, failed: 1, archived: 0 });
    expect(done.notes.failed).toEqual([{ path: 'Jane Doe', reason: 'no such user: jane' }]);
    expect(done.files.moves).toHaveLength(0);
    expect(stateOf(done.files).people['jane']).toBeDefined();
  });

  it('a page that will not write is reported as failed rather than recorded as written', async () => {
    const done = await run({ files: { failWritesMatching: 'Jane Doe' } });

    expect(done.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(done.notes.failed).toEqual([{ path: 'Jane Doe', reason: `cannot write ${ROOT}/Jane Doe.md` }]);
    expect(stateOf(done.files).people['jane']).toBeUndefined();
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'person.failed', meta: { person: 'jane', cause: 'write-failed' } });
  });

  it('the progress line counts everyone the rosters named, once, by name', async () => {
    const done = await run({ concurrency: 2 });

    expect(done.progress.started).toEqual([{ total: 3, what: 'People' }]);
    expect(done.progress.steps.toSorted((left, right) => left.localeCompare(right))).toEqual(['Dana Farrow', 'Jane Doe', 'Outside Consultant']);
    expect(done.progress.dones).toHaveLength(1);
  });

  it('pages are written a window at a time and the state saved once per window, so a stopped run resumes without rewriting them', async () => {
    const done = await run({ concurrency: 1 });

    expect(done.files.writeLog.filter((path) => path === STATE_PATH)).toHaveLength(3);
  });

  it('a page that will not move aside is logged and the run carries on, whether it was a rename or a leaver', async () => {
    const state = withPerson(withPerson(emptyPeopleState(), 'jane', { file: `${ROOT}/Jane Smith.md`, name: 'Jane Smith', fingerprint: 'old' }), 'gone', {
      file: `${ROOT}/Left Already.md`,
      name: 'Left Already',
      fingerprint: 'x',
    });
    const done = await run({ files: { texts: { [STATE_PATH]: serializePeopleState(state) }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'disk is read-only' } } });

    expect(done.ok).toBe(true);
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: `${ROOT}/Jane Smith.md`, cause: 'write-failed' } });
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'archive.failed', meta: { path: `${ROOT}/Left Already.md`, cause: 'write-failed' } });
  });

  it('the org chart is drawn again when someone left even if nobody else changed, and a chart that will not write is logged rather than failing the run', async () => {
    const teams = { dana: ['NORTHWIND EMPLOYEES', 'Leadership'], jane: ['NORTHWIND EMPLOYEES', 'Leadership'] };
    const settled = withPerson(
      withPerson(emptyPeopleState(), 'dana', { file: `${ROOT}/Dana Farrow.md`, name: 'Dana Farrow', fingerprint: fingerprintOf('dana', [DANA, JANE], teams) }),
      'jane',
      { file: `${ROOT}/Jane Doe.md`, name: 'Jane Doe', fingerprint: fingerprintOf('jane', [DANA, JANE], teams) }
    );
    const withLeaver = withPerson(settled, 'gone', { file: `${ROOT}/Left Already.md`, name: 'Left Already', fingerprint: 'x' });

    const redrawn = await run({ files: { texts: { [STATE_PATH]: serializePeopleState(withLeaver) } } });
    expect(redrawn.summary).toMatchObject({ converted: 0, archived: 1 });
    expect(redrawn.files.writeLog).toContain(`${ROOT}/_org-chart.md`);

    const unwritable = await run({ files: { failWritesMatching: '_org-chart' } });
    expect(unwritable.ok).toBe(true);
    expect(unwritable.logger.calls).toContainEqual({ level: 'warn', event: 'org-chart.failed', meta: { cause: 'write-failed' } });
  });

  it('a Team listing that fails ends the run naming the step, and so does a roster that cannot be read', async () => {
    const noTeams = await run({ failTeams: { step: 'x', cause: 'auth', message: 'sign-in has lapsed' } });
    expect(noTeams.ok).toBe(false);
    expect(noTeams.error).toEqual({ step: 'listTeams', cause: 'auth', message: 'sign-in has lapsed' });

    const noRoster = await run({ reader: { failMembers: { kind: 'transient', message: 'Graph is busy' } } });
    expect(noRoster.ok).toBe(false);
    expect(noRoster.error).toEqual({ step: 'listMembers', cause: 'transient', message: 'Graph is busy' });
  });

  it('a dry run reads the directory, says how many pages it would write, and writes nothing at all', async () => {
    const done = await run({ dryRun: true });

    expect(done.summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 2 });
    expect(done.files.writeLog).toHaveLength(0);
  });

  it('a state file this version cannot read is started over rather than written back over', async () => {
    const done = await run({ files: { texts: { [STATE_PATH]: '{"version":99,"source":{"kind":"people","id":"people","name":"People"}}' } } });

    expect(done.summary.converted).toBe(2);
    expect(done.logger.calls.map((entry) => entry.event)).toContain('people-state.unreadable');
  });

  it('a state file that cannot be saved stops the run, whether or not there was anything to write', async () => {
    const busy = await run({ files: { failWritesMatching: '.sync-state.json' } });
    expect(busy.ok).toBe(false);
    expect(busy.error?.step).toBe('saveState');

    const idle = await run({ teams: [], files: { failWritesMatching: '.sync-state.json' } });
    expect(idle.ok).toBe(false);
    expect(idle.error?.step).toBe('saveState');
  });

  it('the log names people by their ids and counts, never by name, address or number', async () => {
    const done = await run({ reader: { failProfiles: ['jane'] } });

    const logged = JSON.stringify(done.logger.calls);
    expect(logged).not.toContain('Jane');
    expect(logged).not.toContain('example.com');
  });
});
