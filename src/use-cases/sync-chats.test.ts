import { describe, expect, it } from 'bun:test';
import type { Chat } from '../domain/chat.ts';
import { pictureMarker } from '../domain/chat-message.ts';
import type { ChatMessage } from '../domain/chat-message.ts';
import type { ChatsState } from '../domain/chat-state.ts';
import type { DriveItem } from '../domain/drive-item.ts';
import { compareText } from '../domain/utilities/compare-text.ts';
import { createChatReaderFake } from '../test-helpers/chat-reader-fake.ts';
import type { ChatReaderFake, ChatReaderSeed } from '../test-helpers/chat-reader-fake.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderFake, DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import type { OcrSeed } from '../test-helpers/ocr-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import { createConvertFile } from './convert-file.ts';
import type { Ocr } from './ports/ocr.ts';
import type { StepError } from './ports/step-error.ts';
import { createSyncChats } from './sync-chats.ts';
import type { SyncChatsInput } from './sync-chats.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

const ROOT = 'kb/Chats';
const STATE_PATH = `${ROOT}/.sync-state.json`;
const BUDGET_ID = '19:aaa111@thread.v2';
const JANE_ID = '19:0000-jane_0000-me@unq.gbl.spaces';

const chat = (over: Partial<Chat> = {}): Chat => ({
  id: BUDGET_ID,
  kind: 'group',
  topic: 'Budget review',
  members: ['Jane Doe', 'Li Wei'],
  lastMessageAt: '2026-11-13T09:00:00.0000000Z',
  ...over,
});

const BUDGET = chat();
const JANE = chat({ id: JANE_ID, kind: 'oneOnOne', topic: '', members: ['Jane Doe'], lastMessageAt: '2026-11-12T08:00:00.0000000Z' });

const message = (id: string, sent: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author: 'Jane Doe',
  sent,
  text: `message ${id}`,
  files: [],
  pictures: 0,
  webUrl: '',
  ...over,
});

const BUDGET_MESSAGES = [message('m1', '2026-11-12T10:00:00.0000000Z'), message('m2', '2026-11-13T09:00:00.0000000Z', { author: 'Li Wei' })];
const JANE_MESSAGES = [message('m3', '2026-11-12T08:00:00.0000000Z')];

const TWO_CHATS: ChatReaderSeed = { chats: [BUDGET, JANE], messages: { [BUDGET_ID]: BUDGET_MESSAGES, [JANE_ID]: JANE_MESSAGES } };

// OCR that is off answers every read `unavailable` and says it is off, as the composition's does.
const OCR_OFF: Ocr = { ...createOcrFake({ failWith: { kind: 'unavailable', message: 'OCR is off' } }), off: true };

type Seeds = {
  readonly reader?: ChatReaderSeed;
  // The disk a run starts from: a fresh one from a seed, or the disk an earlier run left.
  readonly files?: FilesFakeSeed;
  readonly onto?: FilesFake;
  readonly drive?: DriveReaderSeed;
  readonly ocr?: OcrSeed | 'off';
  readonly input?: Partial<SyncChatsInput>;
  readonly timezone?: string;
  readonly now?: string;
};

type Ran = {
  readonly ok: boolean;
  readonly error?: StepError;
  readonly summary: RunSummary;
  readonly notes: RunNotes;
  readonly files: FilesFake;
  readonly logger: LoggerFake;
  readonly progress: ProgressFake;
  readonly reader: ChatReaderFake;
  readonly drive: DriveReaderFake;
};

const NOTHING = { summary: { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 }, notes: { skipped: [], failed: [], givenUp: [], archived: [] } };

const run = async (seeds: Seeds = {}): Promise<Ran> => {
  const files = seeds.onto ?? createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const reader = createChatReaderFake(seeds.reader ?? TWO_CHATS);
  const drive = createDriveReaderFake(seeds.drive);
  const clock = createClockFake(seeds.now ?? '2026-11-14T01:00:00Z');
  const ocr = seeds.ocr === 'off' ? OCR_OFF : createOcrFake(seeds.ocr);
  const syncChats = createSyncChats({
    reader,
    drive,
    files,
    ocr,
    clock,
    logger,
    progress,
    kbRoot: 'kb',
    timezone: seeds.timezone ?? 'UTC',
    convertFile: createConvertFile({ reader: drive, files, ocr, clock, logger, progress: createProgressFake() }),
  });
  const outcome = await syncChats({ dryRun: false, concurrency: 4, maxBytes: 50 * 1024 * 1024, all: true, ...seeds.input });
  return outcome.ok
    ? { ...outcome.value, files, logger, progress, reader, drive, ok: true }
    : { ...NOTHING, files, logger, progress, reader, drive, ok: false, error: outcome.error };
};

const stateOf = (files: FilesFake): ChatsState => JSON.parse(files.written.get(STATE_PATH) ?? '{}') as ChatsState;

const notesWritten = (files: FilesFake): ReadonlyArray<string> =>
  [...files.written.keys()].filter((path) => /\/\d{4}-\d{2}-\d{2}\.md$/.test(path) && !path.includes('/_archive/')).toSorted(compareText);

// Everything a later run wrote, by path, in order.
const writtenSince = (files: FilesFake, mark: number): ReadonlyArray<string> => files.writeLog.slice(mark);

describe('syncing the Teams chats', () => {
  it('a first run writes one note for each chat and day, a page for each chat, a page for all of them, and the state', async () => {
    const { ok, summary, notes, files, logger, progress } = await run();

    expect(ok).toBe(true);
    expect(summary).toEqual({ ...NOTHING.summary, converted: 3 });
    expect(notes).toEqual(NOTHING.notes);
    expect(logger.calls.filter((call) => call.level === 'warn')).toStrictEqual([]);
    expect(progress.begins.toSorted(compareText)).toEqual(['Budget review', 'Jane Doe']);
    expect(stateOf(files).chats[BUDGET_ID]?.days['2026-11-13']?.held).toStrictEqual([]);
    expect(notesWritten(files)).toEqual([`${ROOT}/Budget review/2026-11-12.md`, `${ROOT}/Budget review/2026-11-13.md`, `${ROOT}/Jane Doe/2026-11-12.md`]);
    expect(files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toBe(
      [
        '---',
        'source: Teams chat',
        'chat: Budget review',
        'kind: group',
        'members:',
        '  - Jane Doe',
        '  - Li Wei',
        'day: "2026-11-13"',
        'messages: 1',
        'synced_at: "2026-11-14T01:00:00Z"',
        '---',
        '',
        '# Budget review, 2026-11-13',
        '',
        '### 09:00 · Li Wei',
        '',
        'message m2',
        '',
      ].join('\n')
    );
    expect(files.written.get(`${ROOT}/Budget review/_index.md`)).toContain('- [2026-11-13](2026-11-13.md) · 1 message\n- [2026-11-12](2026-11-12.md) · 1 message\n');
    expect(files.written.get(`${ROOT}/_index.md`)).toContain(
      '- 2026-11-13 · [Budget review](<Budget review/_index.md>) · group\n- 2026-11-12 · [Jane Doe](<Jane Doe/_index.md>) · one-to-one\n'
    );
  });

  it('the state names the source, follows every chat, and records each chat with its folder, its last message and its days', async () => {
    const { files } = await run();
    const state = stateOf(files);

    expect(state.source).toEqual({ kind: 'chats', id: 'chats', name: 'Chats' });
    expect(state.follow).toBe('all');
    expect(state.lastRun).toBe('2026-11-14T01:00:00Z');
    expect(state.chats[JANE_ID]).toMatchObject({ name: 'Jane Doe', folder: 'Jane Doe', kind: 'oneOnOne', lastMessageAt: '2026-11-12T08:00:00.0000000Z' });
    expect(Object.keys(state.chats[BUDGET_ID]?.days ?? {})).toEqual(['2026-11-12', '2026-11-13']);
    expect(state.chats[BUDGET_ID]?.days['2026-11-13']).toMatchObject({ file: `${ROOT}/Budget review/2026-11-13.md`, messages: 1 });
    expect(state.chats[BUDGET_ID]?.days['2026-11-13']?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a message is filed under the day it was written where the knowledge base counts its days', async () => {
    const { files } = await run({ timezone: 'Asia/Shanghai', reader: { chats: [BUDGET], messages: { [BUDGET_ID]: [message('late', '2026-11-13T23:30:00.0000000Z')] } } });

    expect(notesWritten(files)).toEqual([`${ROOT}/Budget review/2026-11-14.md`]);
    expect(files.written.get(`${ROOT}/Budget review/2026-11-14.md`)).toContain('### 07:30 · Jane Doe');
  });

  it('a second run with no new message reads no chat and writes no note', async () => {
    const first = await run();
    const mark = first.files.writeLog.length;

    const second = await run({ onto: first.files });

    expect(second.reader.calls).toEqual(['listChats']);
    expect(second.summary).toEqual(NOTHING.summary);
    expect(writtenSince(first.files, mark)).toEqual([STATE_PATH, `${ROOT}/_index.md`]);
    expect(second.progress.started).toEqual([{ total: 0, what: 'Chats' }]);
  });

  it('a new message writes the note of its day again, from a read that starts the day before, and the earlier version goes under the archive', async () => {
    const first = await run();
    const before = first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`);
    const mark = first.files.writeLog.length;
    const moved = chat({ lastMessageAt: '2026-11-13T11:00:00.0000000Z' });
    const messages = [...BUDGET_MESSAGES, message('m4', '2026-11-13T11:00:00.0000000Z')];

    const second = await run({ onto: first.files, reader: { chats: [moved, JANE], messages: { [BUDGET_ID]: messages } } });

    expect(second.reader.days).toEqual([`${BUDGET_ID}:2026-11-12`]);
    expect(second.summary.converted).toBe(1);
    expect(first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('### 11:00 · Jane Doe\n\nmessage m4\n');
    expect(first.files.written.get('kb/_archive/2026-11-14/Chats/Budget review/2026-11-13.md')).toBe(before);
    expect(writtenSince(first.files, mark)).not.toContain(`${ROOT}/Budget review/2026-11-12.md`);
    expect(stateOf(first.files).chats[BUDGET_ID]?.lastMessageAt).toBe('2026-11-13T11:00:00.0000000Z');
    expect(second.logger.calls.filter((call) => call.level === 'warn')).toStrictEqual([]);
  });

  it('a day the chat no longer holds goes under the archive, and the report says so', async () => {
    const first = await run();
    const moved = chat({ lastMessageAt: '2026-11-14T00:30:00.0000000Z' });
    const messages = [BUDGET_MESSAGES[0] as ChatMessage, message('m5', '2026-11-14T00:30:00.0000000Z')];

    const second = await run({ onto: first.files, reader: { chats: [moved, JANE], messages: { [BUDGET_ID]: messages } } });

    expect(second.summary).toEqual({ ...NOTHING.summary, converted: 1, archived: 1 });
    expect(second.notes.archived).toEqual([{ path: 'Budget review/2026-11-13', reason: 'no message left at the source' }]);
    expect(notesWritten(first.files)).toEqual([`${ROOT}/Budget review/2026-11-12.md`, `${ROOT}/Budget review/2026-11-14.md`, `${ROOT}/Jane Doe/2026-11-12.md`]);
    expect(first.files.written.has('kb/_archive/2026-11-14/Chats/Budget review/2026-11-13.md')).toBe(true);
    expect(Object.keys(stateOf(first.files).chats[BUDGET_ID]?.days ?? {})).toEqual(['2026-11-12', '2026-11-14']);
  });

  it('a day the chat no longer holds whose note will not move is dropped from the record all the same, and the move is logged', async () => {
    const first = await run();
    const stuck = createFilesFake({ texts: Object.fromEntries(first.files.written), failMoveWith: { kind: 'write-failed', path: 'x', message: 'the file is open' } });
    const moved = chat({ lastMessageAt: '2026-11-14T00:30:00.0000000Z' });

    const second = await run({
      onto: stuck,
      reader: { chats: [moved, JANE], messages: { [BUDGET_ID]: [BUDGET_MESSAGES[0] as ChatMessage, message('m5', '2026-11-14T00:30:00.0000000Z')] } },
    });

    expect(second.summary.archived).toBe(1);
    expect(second.logger.calls).toContainEqual({ level: 'warn', event: 'archive.failed', meta: { path: `${ROOT}/Budget review/2026-11-13.md`, cause: 'write-failed' } });
    expect(Object.keys(stateOf(stuck).chats[BUDGET_ID]?.days ?? {})).toEqual(['2026-11-12', '2026-11-14']);
  });

  it('messages before the kept day are not asked for, and a chat that went quiet before it is not read', async () => {
    const { reader, files } = await run({ input: { since: '2026-11-13' } });

    expect(reader.days).toEqual([`${BUDGET_ID}:2026-11-13`]);
    expect(notesWritten(files)).toEqual([`${ROOT}/Budget review/2026-11-13.md`]);
    expect(stateOf(files).chats[BUDGET_ID]?.since).toBe('2026-11-13');
  });

  it('an earlier kept day reads each chat again from that day, and leaves a note that did not change as it is', async () => {
    const first = await run({ input: { since: '2026-11-13' } });
    const mark = first.files.writeLog.length;

    const second = await run({ onto: first.files, input: { since: '2026-11-01' } });

    expect(second.reader.days.toSorted(compareText)).toEqual([`${JANE_ID}:2026-11-01`, `${BUDGET_ID}:2026-11-01`].toSorted(compareText));
    expect(second.summary.converted).toBe(2);
    expect(notesWritten(first.files)).toHaveLength(3);
    expect(writtenSince(first.files, mark)).not.toContain(`${ROOT}/Budget review/2026-11-13.md`);
  });

  it('a dry run counts the chats it would read, and writes nothing', async () => {
    const { ok, summary, notes, files, reader } = await run({ input: { dryRun: true } });

    expect(ok).toBe(true);
    expect(summary).toEqual({ ...NOTHING.summary, queued: 2 });
    expect(notes).toEqual(NOTHING.notes);
    expect(files.written.size).toBe(0);
    expect(reader.calls).toEqual(['listChats']);
  });

  it('a chat renamed in Teams keeps its folder, and the page of all chats shows the new name', async () => {
    const first = await run();
    const renamed = chat({ topic: 'Budget 2027', lastMessageAt: '2026-11-14T00:30:00.0000000Z' });
    const messages = [...BUDGET_MESSAGES, message('m5', '2026-11-14T00:30:00.0000000Z')];

    await run({ onto: first.files, reader: { chats: [renamed, JANE], messages: { [BUDGET_ID]: messages } } });

    expect(first.files.written.get(`${ROOT}/Budget review/2026-11-14.md`)).toContain('chat: Budget 2027\n');
    expect(first.files.written.get(`${ROOT}/_index.md`)).toContain('[Budget 2027](<Budget review/_index.md>)');
    expect(first.files.written.get(`${ROOT}/Budget review/_index.md`)).toContain('# Budget 2027\n');
  });
});
