import type { Member, Person } from '../domain/person.ts';
import { err, ok } from '../domain/result.ts';
import type { PeopleReader, PeopleReaderError } from '../use-cases/ports/people-reader.ts';

export type PeopleReaderSeed = {
  // Rosters keyed by team id.
  readonly members?: Readonly<Record<string, ReadonlyArray<Member>>>;
  // Profiles keyed by user id; a user with no profile here fails to read, the way one who has just
  // been deleted from the directory does.
  readonly profiles?: Readonly<Record<string, Person>>;
  readonly failMembers?: PeopleReaderError;
  // Only the users named here fail to read, so one can fail while the rest land beside them.
  readonly failProfiles?: ReadonlyArray<string>;
};

export type PeopleReaderFake = PeopleReader & { readonly calls: Array<string> };

export const createPeopleReaderFake = (seed: PeopleReaderSeed = {}): PeopleReaderFake => {
  const calls: string[] = [];
  return {
    calls,
    teamMembers: async (teamId) => {
      calls.push(`teamMembers:${teamId}`);
      return seed.failMembers === undefined ? ok(seed.members?.[teamId] ?? []) : err(seed.failMembers);
    },
    profile: async (userId) => {
      calls.push(`profile:${userId}`);
      const person = seed.profiles?.[userId];
      if (person === undefined || (seed.failProfiles ?? []).includes(userId)) return err({ kind: 'permanent', message: `no such user: ${userId}` });
      return ok(person);
    },
  };
};
