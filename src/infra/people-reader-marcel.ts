import { parseMember, parsePerson } from '../domain/person.ts';
import type { Member } from '../domain/person.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { canonicalCursor } from '../domain/utilities/graph-cursor.ts';
import type { PeopleReader, PeopleReaderError } from '../use-cases/ports/people-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { listOf, readString } from './mail-reader-marcel.ts';

// What a colleague wants to know about a person, asked for by name because `get-user` answers a
// slimmer default set that leaves the account state and the user type out, and those two are what
// tell a colleague from a guest or a leaver.
const PROFILE_FIELDS = 'id,displayName,jobTitle,department,mail,userPrincipalName,mobilePhone,businessPhones,officeLocation,accountEnabled,userType';

// The manager in the same call rather than a second one per person: the directory is read whole
// every run, and a hundred people is a hundred calls rather than two hundred.
const WITH_MANAGER = 'manager($select=id,displayName)';

type MembersPage = { readonly members: ReadonlyArray<Member>; readonly next?: string };

export const createPeopleReaderFromCall = (call: MarcelCall): PeopleReader => {
  const page = async (name: string, params: Record<string, string>): Promise<Result<MembersPage, PeopleReaderError>> => {
    const raw = await call(name, params);
    if (!raw.ok) return raw;
    const members = listOf(raw.value).flatMap((entry: unknown) => {
      const member = parseMember(entry);
      return member === undefined ? [] : [member];
    });
    const next = canonicalCursor(readString(raw.value, '@odata.nextLink'));
    return ok(next === undefined ? { members } : { members, next });
  };

  return {
    // Followed to the end of the roster before it is handed back: half a Team looks exactly like a
    // Team half of whose members have left, and the sync would put those people aside.
    teamMembers: async (teamId) => {
      const found: Member[] = [];
      const seen = new Set<string>();
      let next: { readonly name: string; readonly params: Record<string, string> } | undefined = { name: 'list-team-members', params: { teamId } };
      while (next !== undefined) {
        const answered: Result<MembersPage, PeopleReaderError> = await page(next.name, next.params);
        if (!answered.ok) return answered;
        found.push(...answered.value.members);
        const link = answered.value.next;
        next = link === undefined || seen.has(link) ? undefined : { name: 'next-page', params: { url: link } };
        if (link !== undefined) seen.add(link);
      }
      return ok(found);
    },
    profile: async (userId) => {
      const raw = await call('get-user', { userId, select: PROFILE_FIELDS, expand: WITH_MANAGER });
      if (!raw.ok) return raw;
      const person = parsePerson(raw.value);
      return person === undefined ? err({ kind: 'permanent', message: `Graph returned no user for ${userId}` }) : ok(person);
    },
  };
};
