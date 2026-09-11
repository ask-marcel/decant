import { contentHash } from './content-hash.ts';

// One person in the directory, as `get-user` answers with the manager expanded. What a colleague
// would want to know about them and nothing else: no preferred language, no photo, no licence.
export type Person = {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly department: string;
  readonly email: string;
  readonly phones: ReadonlyArray<string>;
  readonly office: string;
  // A disabled account is someone who has left; a guest is someone from outside. Both are read so
  // the sync can leave them out on purpose rather than by accident.
  readonly enabled: boolean;
  readonly member: boolean;
  readonly manager: { readonly id: string; readonly name: string } | undefined;
};

// One entry in a Team's roster: the user behind the membership, never the membership itself, whose
// id is the Team's business and changes when a person leaves and rejoins.
export type Member = { readonly userId: string; readonly name: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

const MEMBER = 'Member';

// The mobile number first, then the business numbers, blanks and repeats gone: one list a reader
// can dial down, not two fields to compare.
const phonesOf = (raw: Record<string, unknown>): ReadonlyArray<string> => {
  const business = Array.isArray(raw['businessPhones']) ? raw['businessPhones'].filter((entry): entry is string => typeof entry === 'string') : [];
  return [...new Set([readString(raw, 'mobilePhone') ?? '', ...business].filter((phone) => phone.length > 0))];
};

const managerOf = (raw: unknown): Person['manager'] => {
  const id = readString(raw, 'id');
  return id === undefined ? undefined : { id, name: readString(raw, 'displayName') ?? id };
};

export const parsePerson = (raw: unknown): Person | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  const email = readString(raw, 'mail') ?? '';
  return {
    id,
    name: readString(raw, 'displayName') ?? (email.length > 0 ? email : id),
    title: readString(raw, 'jobTitle') ?? '',
    department: readString(raw, 'department') ?? '',
    email,
    phones: phonesOf(raw),
    office: readString(raw, 'officeLocation') ?? '',
    // Both default to the ordinary case, since `get-user` only states them when asked to.
    enabled: raw['accountEnabled'] !== false,
    member: (readString(raw, 'userType') ?? MEMBER) === MEMBER,
    manager: managerOf(raw['manager']),
  };
};

export const isColleague = (person: Person): boolean => person.enabled && person.member;

export const parseMember = (raw: unknown): Member | undefined => {
  const userId = readString(raw, 'userId');
  return userId === undefined ? undefined : { userId, name: readString(raw, 'displayName') ?? userId };
};

// What the person's document is made of, hashed, so a run can tell a person who changed from one
// who did not without reading the file back. The teams and the reports are part of it because they
// are part of the document, and both are lists whose order means nothing.
export const personFingerprint = (person: Person, teams: ReadonlyArray<string>, reportIds: ReadonlyArray<string>): string =>
  contentHash(
    new TextEncoder().encode(JSON.stringify([person, [...teams].sort((left, right) => left.localeCompare(right)), [...reportIds].sort((left, right) => left.localeCompare(right))]))
  );
