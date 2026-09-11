import type { Member, Person } from '../../domain/person.ts';
import type { Result } from '../../domain/result.ts';
import type { DriveReaderError } from './drive-reader.ts';

export type PeopleReaderError = DriveReaderError;

// The directory is read two ways, neither of them a listing of it: the roster of a Team says who
// is in it, and one call per person says who they are. There is no `/users` command in the library
// and no delta, so this is what enumerating the people of a tenant comes to.
export type PeopleReader = {
  // Everyone in one Team, followed to the end of the roster before it is handed back.
  readonly teamMembers: (teamId: string) => Promise<Result<ReadonlyArray<Member>, PeopleReaderError>>;
  // One person, with their manager expanded into the same call.
  readonly profile: (userId: string) => Promise<Result<Person, PeopleReaderError>>;
};
