import type { GroupThread } from '../../domain/group-thread.ts';
import type { Result } from '../../domain/result.ts';
import type { MailReaderError, ThreadReader } from './mail-reader.ts';

// A Microsoft 365 group the signed-in user belongs to. Belonging is the point: access is
// membership-gated rather than scope-gated, so a group listed by the tenant's directory but not
// joined answers `ErrorAccessDenied` on every read. What this lists is what can actually be read.
export type GroupSummary = { readonly id: string; readonly name: string; readonly mail: string };

// Finding the threads of a group inbox, and then reading one by the same eight methods any thread
// is read by. The half that finds is all a group needs of its own: there are no folders to walk and
// no RFC headers to reconcile, because Graph hands out a thread id that is stable already.
export type GroupReader = ThreadReader & {
  readonly listGroups: () => Promise<Result<ReadonlyArray<GroupSummary>, MailReaderError>>;
  // Newest first, which is the only ordering an incremental sweep can use: group threads have no
  // delta endpoint and Graph refuses `$filter` on the collection.
  readonly threads: (groupId: string) => Promise<Result<ReadonlyArray<GroupThread>, MailReaderError>>;
};
