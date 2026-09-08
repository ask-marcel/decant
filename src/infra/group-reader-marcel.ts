import { parseGroupPost, parseGroupThread, refParts } from '../domain/group-thread.ts';
import type { GroupThread } from '../domain/group-thread.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { GroupReader, GroupSummary } from '../use-cases/ports/group-reader.ts';
import type { MailReaderError } from '../use-cases/ports/mail-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { listOf, readString, toAttachment, toBytes } from './mail-reader-marcel.ts';

// A group inbox reads through the same commands a person would run, with three parts of the mail
// side deliberately absent because 2.5.0 has no group equivalent: an attachment cannot be rendered
// to PDF, its embedded pictures cannot be extracted, and a post's SharePoint links cannot be
// resolved. Each answers below with the honest empty rather than a wrong value, and the gap is
// written up in `docs/request-group-post-parity.md` rather than worked around here.
const NO_GROUP_COMMAND = (what: string): MailReaderError => ({ kind: 'unrenderable', message: `a group post has no ${what} command in ask-marcel-office-cli 2.5.0` });

const UNIFIED = 'Unified';

// Graph pages a thread listing with its own next link, which is the cursor `next-page` follows.
const nextLinkOf = (value: unknown): string | undefined => readString(value, '@odata.nextLink');

const groupsOf = (raw: unknown): ReadonlyArray<GroupSummary> =>
  listOf(raw).flatMap((entry: unknown) => {
    const id = readString(entry, 'id');
    const mail = readString(entry, 'mail');
    const types = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['groupTypes'] : undefined;
    const unified = Array.isArray(types) && types.includes(UNIFIED);
    return id === undefined || mail === undefined || !unified ? [] : [{ id, name: readString(entry, 'displayName') ?? mail, mail }];
  });

const NEWEST_FIRST = 'lastDeliveredDateTime desc';

const PAGE_SIZE = '50';

export const createGroupReaderFromCall = (call: MarcelCall): GroupReader => {
  const textOf = async (name: string, params: Record<string, string>): Promise<Result<string, MailReaderError>> => {
    const raw = await call(name, params);
    return raw.ok ? ok(readString(raw.value, 'text') ?? '') : raw;
  };

  const bytesOf = async (name: string, params: Record<string, string>): Promise<Result<Uint8Array, MailReaderError>> => {
    const raw = await call(name, params);
    return raw.ok ? toBytes(raw.value) : raw;
  };

  // The topic of a thread is not on its posts, and Graph has no command answering for one thread by
  // id, so it is remembered as the sweep lists it. Every read of a post follows a listing of the
  // threads holding it, which is the order `syncGroup` works in; a topic that was never listed
  // leaves the post unnamed rather than failing, and the thread's own folder still names it.
  const topics = new Map<string, GroupThread>();

  const threadsPage = async (params: Record<string, string>): Promise<Result<{ readonly threads: ReadonlyArray<GroupThread>; readonly next?: string }, MailReaderError>> => {
    const raw = await call('list-group-threads', params);
    if (!raw.ok) return raw;
    const threads = listOf(raw.value).flatMap((entry: unknown) => {
      const thread = parseGroupThread(entry);
      if (thread === undefined) return [];
      topics.set(thread.id, thread);
      return [thread];
    });
    const next = nextLinkOf(raw.value);
    return ok(next === undefined ? { threads } : { threads, next });
  };

  const postsOf = async (ref: string): Promise<Result<ReadonlyArray<MailMessage>, MailReaderError>> => {
    const parts = refParts(ref);
    if (parts === undefined) return err({ kind: 'permanent', message: `not a group thread reference: ${ref}` });
    const raw = await call('list-group-thread-posts', { groupId: parts.groupId, threadId: parts.threadId });
    if (!raw.ok) return raw;
    const thread = topics.get(parts.threadId) ?? { id: parts.threadId, topic: '', lastDelivered: '', hasAttachments: false };
    return ok(
      listOf(raw.value).flatMap((entry: unknown) => {
        const post = parseGroupPost(entry, thread, parts.groupId);
        return post === undefined ? [] : [post];
      })
    );
  };

  const forPost = async <T>(
    ref: string,
    read: (parts: { groupId: string; threadId: string; postId: string }) => Promise<Result<T, MailReaderError>>
  ): Promise<Result<T, MailReaderError>> => {
    const parts = refParts(ref);
    return parts === undefined ? err({ kind: 'permanent', message: `not a group post reference: ${ref}` }) : read(parts);
  };

  return {
    listGroups: async () => {
      const raw = await call('list-my-memberships', {});
      return raw.ok ? ok(groupsOf(raw.value)) : raw;
    },
    threads: async (groupId) => {
      const found: GroupThread[] = [];
      let params: Record<string, string> | undefined = { groupId, orderby: NEWEST_FIRST, top: PAGE_SIZE };
      while (params !== undefined) {
        const page: Result<{ readonly threads: ReadonlyArray<GroupThread>; readonly next?: string }, MailReaderError> = await threadsPage(params);
        if (!page.ok) return page;
        found.push(...page.value.threads);
        params = page.value.next === undefined ? undefined : { url: page.value.next };
      }
      return ok(found);
    },
    conversation: postsOf,
    messageMarkdown: async (ref) => forPost(ref, (parts) => textOf('convert-group-post-to-markdown', { groupId: parts.groupId, threadId: parts.threadId, postId: parts.postId })),
    attachments: async (ref) =>
      forPost(ref, async (parts) => {
        const raw = await call('list-group-post-attachments', { groupId: parts.groupId, threadId: parts.threadId, postId: parts.postId });
        return raw.ok ? ok(listOf(raw.value).flatMap(toAttachment)) : raw;
      }),
    attachmentMarkdown: async (ref, attachmentId) =>
      forPost(ref, (parts) => textOf('convert-group-post-attachment-to-markdown', { groupId: parts.groupId, threadId: parts.threadId, postId: parts.postId, attachmentId })),
    attachmentBytes: async (ref, attachmentId) =>
      forPost(ref, (parts) => bytesOf('get-group-post-attachment', { groupId: parts.groupId, threadId: parts.threadId, postId: parts.postId, attachmentId })),
    attachmentPdf: async () => err(NO_GROUP_COMMAND('attachment-to-pdf')),
    attachmentImages: async () => ok([] as ReadonlyArray<never>),
    sharepointLinks: async () => ok([]),
  };
};
