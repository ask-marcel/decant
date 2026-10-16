import { describe, expect, it } from 'bun:test';
import { contentHash } from '../domain/content-hash.ts';
import { threadIdOf } from '../domain/thread-id.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { createMailReaderFake } from '../test-helpers/mail-reader-fake.ts';
import type { MailReaderSeed } from '../test-helpers/mail-reader-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import { INLINE_STORE, message } from '../test-helpers/thread-harness.ts';
import { createConvertAttachment } from './convert-attachment.ts';
import type { ConvertAttachment } from './convert-attachment.ts';
import { createConvertFile } from './convert-file.ts';
import { createRenderThread } from './render-thread.ts';
import type { RenderThread, RenderThreadInput } from './render-thread.ts';

// A mailbox renders a window of threads side by side, each from the store as the window found it. A
// picture new to the store and shown in two of them is one file, converted once.
describe('threads written side by side', () => {
  const picture = (name: string): ReadonlyArray<{ id: string; name: string; contentType: string; size: number; isInline: boolean; contentId: string }> => [
    { id: 'sig', name, contentType: 'image/png', size: 64 * 1024, isInline: true, contentId: `${name}@01DC1234` },
  ];
  // Each test reads its own fake, which counts the calls made of it.
  const seed: MailReaderSeed = {
    conversations: { 'conv-a': [message({ id: 'm1', conversationId: 'conv-a' })], 'conv-b': [message({ id: 'm2', conversationId: 'conv-b', subject: 'Offsite' })] },
    bodies: { m1: '\\[inline image: image001.png\\]', m2: '\\[inline image: image002.png\\]' },
    attachments: { m1: picture('image001.png'), m2: picture('image002.png') },
  };
  const input = (conversation: string, root: string, attachments: RenderThreadInput['attachments'] = {}): RenderThreadInput => ({
    threadId: threadIdOf(root),
    label: conversation,
    conversationIds: [conversation],
    root,
    folder: '',
    maxBytes: 50 * 1024 * 1024,
    linked: {},
    attachments,
  });

  const renderWith = (files: FilesFake, convert?: (real: ConvertAttachment) => ConvertAttachment): RenderThread => {
    const reader = createMailReaderFake(seed);
    const logger = createLoggerFake();
    const drive = createDriveReaderFake();
    const progress = createProgressFake();
    const real = createConvertAttachment({ reader, files, ocr: createOcrFake(), logger, unpackArchive: drive.localArchive, convertLocal: drive.localMarkdown });
    return createRenderThread({
      reader,
      drive,
      files,
      logger,
      progress,
      clock: createClockFake(),
      sourceName: 'Mailbox',
      mailboxRoot: 'kb/Mailbox',
      timezone: 'Europe/Paris',
      convertAttachment: convert === undefined ? real : convert(real),
      convertFile: createConvertFile({ reader: drive, files, ocr: createOcrFake(), clock: createClockFake(), logger, progress }),
    });
  };
  const inlineFiles = (files: FilesFake): ReadonlyArray<string> => [...files.binary.keys()].filter((path) => path.startsWith(`${INLINE_STORE}/`));

  it('a picture new to the store and shown in both is converted once, under one name', async () => {
    const files = createFilesFake();
    const render = renderWith(files);

    const [first, second] = await Promise.all([render(input('conv-a', '<a@example.com>')), render(input('conv-b', '<b@example.com>'))]);

    expect(inlineFiles(files)).toHaveLength(1);
    expect(first?.ok && second?.ok).toBe(true);
  });

  // The store also holds the files of other threads by the same address. A conversion that did not
  // land leaves the threads waiting on it to convert the picture themselves, and never hands them the
  // file of another thread to show.
  it('a conversion that does not land leaves the other thread to convert the picture, never to show another thread`s file', async () => {
    const files = createFilesFake({ failByteWritesMatching: '_inline' });
    const other = 'kb/Mailbox/threads/2026-05-01-other/_attachments';
    const held = { [contentHash(new TextEncoder().encode('bytes sig'))]: { name: 'logo.png', paths: [`${other}/logo.png`], primary: `${other}/logo.png.md`, media: [] } };
    const render = renderWith(files);

    await Promise.all([render(input('conv-a', '<a@example.com>', held)), render(input('conv-b', '<b@example.com>', held))]);

    expect([...files.written.values()].filter((text) => text.includes('2026-05-01-other'))).toStrictEqual([]);
  });

  // A conversion that throws is a bug, and it reaches the thread that asked for it. The other thread
  // does not wait on it for nothing: it converts the picture itself.
  it('a conversion that throws in one thread leaves the other to convert the picture itself', async () => {
    const files = createFilesFake();
    let calls = 0;
    const render = renderWith(files, (real) => async (converting) => {
      calls += 1;
      if (calls === 1) throw new Error('a bug in the converter');
      return real(converting);
    });

    const settled = await Promise.allSettled([render(input('conv-a', '<a@example.com>')), render(input('conv-b', '<b@example.com>'))]);

    expect(settled.map((one) => one.status).toSorted((left, right) => left.localeCompare(right))).toStrictEqual(['fulfilled', 'rejected']);
    expect(inlineFiles(files)).toHaveLength(1);
  });
});
