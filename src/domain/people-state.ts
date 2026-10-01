import type { Colleague } from './directory.ts';
import { disambiguateSegment, safeSegment } from './kb-path.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export const PEOPLE_STATE_VERSION = 1;

// One source, the way the mailbox is one: there is one directory, and it stands beside the mailbox
// in the picker rather than under a heading it would be the only thing under.
export const PEOPLE_ID = 'people';
export const PEOPLE_NAME = 'People';

// One person already written. The fingerprint is what a later run compares against, since Graph
// offers no delta on people the library exposes and the profiles are read whole every run; the
// file is what moves aside when the person is renamed or leaves; the name is what is left to call
// them by once the directory no longer has them.
export type PersonRecord = { readonly file: string; readonly name: string; readonly fingerprint: string };

export type PeopleState = {
  readonly version: typeof PEOPLE_STATE_VERSION;
  readonly source: { readonly kind: 'people'; readonly id: typeof PEOPLE_ID; readonly name: typeof PEOPLE_NAME };
  readonly lastRun: string;
  readonly people: Readonly<Record<string, PersonRecord>>;
};

export type PeopleStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyPeopleState = (): PeopleState => ({ version: PEOPLE_STATE_VERSION, source: { kind: 'people', id: PEOPLE_ID, name: PEOPLE_NAME }, lastRun: '', people: {} });

export const serializePeopleState = (state: PeopleState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const recordOf = (entry: Record<string, unknown>): PersonRecord => ({
  file: readString(entry, 'file') ?? '',
  name: readString(entry, 'name') ?? '',
  fingerprint: readString(entry, 'fingerprint') ?? '',
});

const peopleOf = (raw: unknown): Readonly<Record<string, PersonRecord>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, recordOf(entry)] as const] : [])));
};

export const parsePeopleState = (raw: unknown): Result<PeopleState, PeopleStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = raw['source'];
  if (!isRecord(source) || readString(source, 'kind') !== 'people') return err({ kind: 'malformed', message: 'state is not the people directory' });
  if (raw['version'] !== PEOPLE_STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${PEOPLE_STATE_VERSION}` });
  return ok({ ...emptyPeopleState(), lastRun: readString(raw, 'lastRun') ?? '', people: peopleOf(raw['people']) });
};

export const withPerson = (state: PeopleState, id: string, record: PersonRecord): PeopleState => ({ ...state, people: { ...state.people, [id]: record } });

export const withoutPerson = (state: PeopleState, id: string): PeopleState => ({
  ...state,
  people: Object.fromEntries(Object.entries(state.people).filter(([held]) => held !== id)),
});

export type PeopleWork = { readonly write: ReadonlyArray<Colleague>; readonly archive: ReadonlyArray<{ readonly id: string; readonly record: PersonRecord }> };

// What the run owes, from the whole directory against the ledger: a newcomer and a changed
// profile are written, an unchanged one is left alone, and whoever the ledger holds that the
// directory no longer does is put aside, which is a leaver, a disabled account, or someone who
// left every Team. Someone the rosters still name but whose profile could not be read this run is
// neither: they are kept where they are, since nothing says they have gone.
export const peopleWorklist = (state: PeopleState, directory: ReadonlyArray<Colleague>, unread: ReadonlyArray<string> = []): PeopleWork => {
  const present = new Set([...directory.map((colleague) => colleague.person.id), ...unread]);
  return {
    write: directory.filter((colleague) => state.people[colleague.person.id]?.fingerprint !== colleague.fingerprint),
    archive: Object.entries(state.people).flatMap(([id, record]) => (present.has(id) ? [] : [{ id, record }])),
  };
};

export type PlannedPerson = { readonly colleague: Colleague; readonly file: string };

const MARKDOWN = '.md';

// Where each person about to be written goes, settled before any is written. Two people can share
// a display name; the second takes a suffix from their own id, the way two documents sharing a name
// in one library do. A file another person's record holds is taken even when that person is
// rewritten this run too: their old page is put aside only once their own write lands, which can
// come after a namesake's write to the same path. A person's own page never stands in their way.
export const planPersonFiles = (root: string, directory: ReadonlyArray<Colleague>, state: PeopleState): ReadonlyArray<PlannedPerson> => {
  const taken = new Set(Object.values(state.people).map((record) => record.file));
  const planned: PlannedPerson[] = [];
  for (const colleague of directory) {
    const name = `${safeSegment(colleague.person.name)}${MARKDOWN}`;
    const plain = `${root}/${name}`;
    const file = taken.has(plain) && plain !== state.people[colleague.person.id]?.file ? `${root}/${disambiguateSegment(name, colleague.person.id)}` : plain;
    taken.add(file);
    planned.push({ colleague, file });
  }
  return planned;
};
