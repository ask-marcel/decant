import { safeSegment } from './kb-path.ts';
import type { SafeSegment } from './kb-path.ts';
import { attachmentOf, mapOf, stringList, threadOf } from './mail-state.ts';
import type { AttachmentRecord, LinkedRecord, ThreadRecord } from './mail-state.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export const GROUP_STATE_VERSION = 1;

// A group's own folder, kept apart from the SharePoint site of the same name. A Microsoft 365 group
// is a site, an inbox and a team wearing one title, and two of those three land in this vault: the
// documents under `MOOV Leadership Team/` and the conversations under
// `MOOV Leadership Team (group inbox)/`. Without the suffix they would be one folder and one state.
export const groupRootName = (name: string): SafeSegment => safeSegment(`${name} (group inbox)`);

// What a group inbox run leaves behind. Smaller than the mailbox's state, and deliberately: there
// are no folders to hold a cursor for, and no conversation-to-thread map, because Graph hands out a
// thread id that is stable on its own. None of the RFC reconstruction the mailbox needs applies.
export type GroupState = {
  readonly version: typeof GROUP_STATE_VERSION;
  readonly source: { readonly kind: 'group'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  // Keyed by Graph's own thread id, which is what the sweep has in hand before fetching anything.
  readonly threads: Readonly<Record<string, ThreadRecord>>;
  readonly linked: Readonly<Record<string, LinkedRecord>>;
  readonly attachments: Readonly<Record<string, AttachmentRecord>>;
};

export type GroupStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyGroupState = (id: string, name: string): GroupState => ({
  version: GROUP_STATE_VERSION,
  source: { kind: 'group', id, name },
  lastRun: '',
  threads: {},
  linked: {},
  attachments: {},
});

export const serializeGroupState = (state: GroupState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

export const parseGroupState = (raw: unknown): Result<GroupState, GroupStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = raw['source'];
  if (!isRecord(source) || readString(source, 'kind') !== 'group') return err({ kind: 'malformed', message: 'state is not a group inbox' });
  if (raw['version'] !== GROUP_STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${GROUP_STATE_VERSION}` });
  return ok({
    version: GROUP_STATE_VERSION,
    source: { kind: 'group', id: readString(source, 'id') ?? '', name: readString(source, 'name') ?? '' },
    lastRun: readString(raw, 'lastRun') ?? '',
    threads: mapOf(raw['threads'], threadOf),
    linked: mapOf(raw['linked'], (entry) => ({ paths: stringList(entry['paths']) })),
    attachments: mapOf(raw['attachments'], attachmentOf),
  });
};

export const withGroupThread = (state: GroupState, threadId: string, record: ThreadRecord): GroupState => ({
  ...state,
  threads: { ...state.threads, [threadId]: record },
});

// The newest post already filed, which is where an incremental sweep stops. Derived from the
// threads rather than stored beside them: group threads have no delta endpoint and `$filter` is
// refused, so ordering newest-first and stopping at this is the only incremental shape Graph
// allows, and a stored number that drifted from what is on disk would either re-read the whole
// inbox or step over a thread. The empty state answers with the empty string, which is older than
// every timestamp Graph writes and so sweeps everything.
export const watermarkOf = (state: GroupState): string =>
  Object.values(state.threads).reduce<string>((newest, thread) => (thread.lastMessage > newest ? thread.lastMessage : newest), '');
