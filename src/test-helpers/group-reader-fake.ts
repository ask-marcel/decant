import type { GroupThread } from '../domain/group-thread.ts';
import { err, ok } from '../domain/result.ts';
import type { GroupReader, GroupSummary } from '../use-cases/ports/group-reader.ts';
import type { MailReaderError } from '../use-cases/ports/mail-reader.ts';
import { createMailReaderFake } from './mail-reader-fake.ts';
import type { MailReaderSeed } from './mail-reader-fake.ts';

// A group inbox is read by the same eight methods a mailbox is, so the fake for those is the
// mailbox's fake: seeding a post is seeding a message, and a test about what a group thread
// produces reads exactly like a test about what a mail thread produces. Only the two ways of
// finding threads are its own.
export type GroupReaderSeed = MailReaderSeed & {
  readonly groups?: ReadonlyArray<GroupSummary>;
  // Threads answered per group id, newest first, the way the adapter orders them.
  readonly threads?: Readonly<Record<string, ReadonlyArray<GroupThread>>>;
  readonly failGroups?: MailReaderError;
  readonly failThreads?: MailReaderError;
};

export type GroupReaderFake = GroupReader & { readonly calls: Array<string> };

export const createGroupReaderFake = (seed: GroupReaderSeed = {}): GroupReaderFake => {
  const mail = createMailReaderFake(seed);
  return {
    calls: mail.calls,
    listGroups: async () => {
      mail.calls.push('listGroups');
      return seed.failGroups === undefined ? ok(seed.groups ?? []) : err(seed.failGroups);
    },
    threads: async (groupId) => {
      mail.calls.push(`threads:${groupId}`);
      return seed.failThreads === undefined ? ok(seed.threads?.[groupId] ?? []) : err(seed.failThreads);
    },
    conversation: mail.conversation,
    messageMarkdown: mail.messageMarkdown,
    attachments: mail.attachments,
    attachmentMarkdown: mail.attachmentMarkdown,
    attachmentPdf: mail.attachmentPdf,
    attachmentBytes: mail.attachmentBytes,
    attachmentImages: mail.attachmentImages,
    sharepointLinks: mail.sharepointLinks,
  };
};
