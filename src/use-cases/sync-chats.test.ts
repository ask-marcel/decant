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

describe('choosing which chats to follow', () => {
  it('a chat named by a part of its name is the one chat followed, and the next run refreshes only that chat', async () => {
    const first = await run({ input: { all: false, chat: 'budget' } });

    expect(first.reader.calls).toEqual(['listChats', `messages:${BUDGET_ID}`]);
    expect(stateOf(first.files).follow).toEqual([BUDGET_ID]);

    const later = { chats: [BUDGET, chat({ ...JANE, lastMessageAt: '2026-11-13T12:00:00.0000000Z' })], messages: { [JANE_ID]: JANE_MESSAGES } };
    const second = await run({ onto: first.files, input: { all: false }, reader: later });

    expect(second.reader.calls).toEqual(['listChats']);
    expect(stateOf(first.files).follow).toEqual([BUDGET_ID]);
  });

  it('a chat is named by its id, by its whole name before any part of a name, or by somebody in it', async () => {
    const group = chat({ id: '19:ccc333@thread.v2', topic: 'Offsite', members: ['Sam Roe'] });
    const seed = { chats: [BUDGET, JANE, group], messages: {} };

    expect(stateOf((await run({ reader: seed, input: { all: false, chat: JANE_ID } })).files).follow).toEqual([JANE_ID]);
    expect(stateOf((await run({ reader: seed, input: { all: false, chat: 'jane doe' } })).files).follow).toEqual([JANE_ID]);
    expect(stateOf((await run({ reader: seed, input: { all: false, chat: 'sam' } })).files).follow).toEqual([group.id]);
  });

  it('a name that fits no chat, or more than one, is refused with the chats it fits, and nothing is read', async () => {
    const none = await run({ input: { all: false, chat: 'payroll' } });
    const many = await run({ input: { all: false, chat: 'jane' } });

    expect(none.error).toEqual({ step: 'findChat', cause: 'bad-choice', message: 'no chat of yours is named payroll' });
    expect(many.error).toEqual({ step: 'findChat', cause: 'bad-choice', message: 'jane names 2 chats, give more of the name or the id: Budget review; Jane Doe' });
    expect(many.reader.calls).toEqual(['listChats']);
    expect(many.files.written.size).toBe(0);
  });

  it('a name that fits many chats is refused with the first ten of them', async () => {
    const teams = Array.from({ length: 11 }, (_unused, at) => chat({ id: `19:team${at}@thread.v2`, topic: `Team ${String(at + 1).padStart(2, '0')}` }));

    const { error } = await run({ reader: { chats: teams }, input: { all: false, chat: 'team' } });

    expect(error?.message).toBe('team names 11 chats, give more of the name or the id: Team 01; Team 02; Team 03; Team 04; Team 05; Team 06; Team 07; Team 08; Team 09; Team 10');
  });

  it('a run told to follow every chat does so from then on, whatever was named before', async () => {
    const first = await run({ input: { all: false, chat: 'budget' } });

    const second = await run({ onto: first.files });

    expect(second.reader.calls).toContain(`messages:${JANE_ID}`);
    expect(stateOf(first.files).follow).toBe('all');
  });
});

describe('when something goes wrong with a chat', () => {
  it('a chat whose messages cannot be read is named as failed and left as it was, while the other chats land', async () => {
    const { ok, summary, notes, files, logger } = await run({ reader: { ...TWO_CHATS, failMessagesOf: { [BUDGET_ID]: { kind: 'transient', message: 'timeout' } } } });

    expect(ok).toBe(true);
    expect(summary).toEqual({ ...NOTHING.summary, converted: 1, failed: 1 });
    expect(notes.failed).toEqual([{ path: 'Budget review', reason: 'its messages could not be read: timeout' }]);
    expect(notesWritten(files)).toEqual([`${ROOT}/Jane Doe/2026-11-12.md`]);
    expect(stateOf(files).chats[BUDGET_ID]).toBeUndefined();
    expect(stateOf(files).retry?.[BUDGET_ID]).toEqual({ attempts: 1, version: BUDGET.lastMessageAt, name: 'Budget review', reason: 'its messages could not be read: timeout' });
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'chat.unread', meta: { chat: BUDGET_ID, cause: 'transient' } });
    expect(files.written.get(`${ROOT}/_sync-report.md`)).toContain('Budget review');
  });

  it('a chat that fails three runs is given up, named so once, and not read again until it has a new message', async () => {
    const failing = { ...TWO_CHATS, failMessagesOf: { [BUDGET_ID]: { kind: 'transient' as const, message: 'timeout' } } };
    const first = await run({ reader: failing });
    await run({ onto: first.files, reader: failing });

    const third = await run({ onto: first.files, reader: failing });

    expect(third.notes.failed).toStrictEqual([]);
    expect(third.notes.gaveUp).toEqual([{ path: 'Budget review', reason: 'its messages could not be read: timeout' }]);

    const fourth = await run({ onto: first.files, reader: failing });

    expect(fourth.reader.calls).toEqual(['listChats']);
    expect(fourth.notes.givenUp).toEqual([{ path: 'Budget review', reason: 'its messages could not be read: timeout' }]);

    const fifth = await run({ onto: first.files, reader: { chats: [chat({ lastMessageAt: '2026-11-14T00:30:00.0000000Z' }), JANE], messages: TWO_CHATS.messages } });

    expect(fifth.summary.converted).toBe(2);
    expect(stateOf(first.files).retry).toBeUndefined();
  });

  it('the chats that cannot be listed end the run of this source with what the source said', async () => {
    const { ok, error, files } = await run({ reader: { failChats: { kind: 'permanent', message: 'Teams did not accept the sign-in for chats' } } });

    expect(ok).toBe(false);
    expect(error).toEqual({ step: 'listChats', cause: 'permanent', message: 'Teams did not accept the sign-in for chats' });
    expect(files.written.size).toBe(0);
  });

  it('a note that cannot be written is named as failed, its day is not recorded, and the next run writes it', async () => {
    const first = await run({ files: { failWritesMatching: 'Budget review/2026-11-13.md' } });

    expect(first.summary).toEqual({ ...NOTHING.summary, converted: 2, failed: 1 });
    expect(first.notes.failed).toEqual([{ path: 'Budget review/2026-11-13', reason: `cannot write ${ROOT}/Budget review/2026-11-13.md` }]);
    expect(Object.keys(stateOf(first.files).chats[BUDGET_ID]?.days ?? {})).toEqual(['2026-11-12']);

    const healed = createFilesFake({ texts: Object.fromEntries(first.files.written) });
    const second = await run({ onto: healed });

    expect(second.reader.days).toEqual([`${BUDGET_ID}:2026-11-11`]);
    expect(notesWritten(healed)).toContain(`${ROOT}/Budget review/2026-11-13.md`);
    expect(stateOf(healed).retry).toBeUndefined();
  });

  it('a note whose earlier version will not move aside waits for a run that can move it, and is left as it was', async () => {
    const first = await run();
    const before = first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`);
    const stuck = createFilesFake({ texts: Object.fromEntries(first.files.written), failMoveWith: { kind: 'write-failed', path: 'x', message: 'the file is open' } });
    const moved = chat({ lastMessageAt: '2026-11-13T11:00:00.0000000Z' });

    const second = await run({ onto: stuck, reader: { chats: [moved, JANE], messages: { [BUDGET_ID]: [...BUDGET_MESSAGES, message('m4', '2026-11-13T11:00:00.0000000Z')] } } });

    expect(second.notes.failed).toHaveLength(1);
    expect(second.notes.failed[0]?.reason).toContain('its earlier version would not move to _archive/');
    expect(stuck.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toBe(before);
    expect(second.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: `${ROOT}/Budget review/2026-11-13.md`, cause: 'write-failed' } });
  });

  it('a run with no chat to read that cannot save its state ends saying so', async () => {
    const first = await run();
    const readOnly = createFilesFake({ texts: Object.fromEntries(first.files.written), failWritesMatching: '.sync-state.json' });

    const second = await run({ onto: readOnly });

    expect(second.ok).toBe(false);
    expect(second.error?.step).toBe('saveState');
    expect(second.reader.calls).toEqual(['listChats']);
  });

  it('a state that does not save starts no more chats, and ends the run saying so', async () => {
    const { ok, error, reader } = await run({ files: { failWritesMatching: '.sync-state.json' }, input: { concurrency: 1 } });

    expect(ok).toBe(false);
    expect(error?.step).toBe('saveState');
    expect(reader.calls.filter((call) => call.startsWith('messages:'))).toHaveLength(1);
  });

  it('a state that cannot be read is left alone and the chats are read as never filed, and a page that will not write is only logged', async () => {
    const { ok, summary, logger } = await run({ files: { texts: { [STATE_PATH]: '{"version": 99}' }, failWritesMatching: '_index.md' } });

    expect(ok).toBe(true);
    expect(summary.converted).toBe(3);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'chats-state.unreadable', meta: { cause: 'not a chats state of this version' } });
    expect(logger.calls.filter((call) => call.event === 'index.failed')).toHaveLength(3);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'index.failed', meta: { path: `${ROOT}/_index.md`, cause: 'write-failed' } });
  });

  it('a state file that is not JSON at all is started over the same way', async () => {
    expect((await run({ files: { texts: { [STATE_PATH]: 'not json' } } })).summary.converted).toBe(3);
  });
});

describe('working through the chats with a limit', () => {
  it('with two places and three chats, the third chat starts when the first one ends, while the second is still open', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const third = chat({ id: '19:ccc333@thread.v2', topic: 'Offsite', lastMessageAt: '2026-11-13T10:00:00.0000000Z' });
    const seed = { chats: [BUDGET, JANE, third], messages: {}, holdMessagesOf: { [BUDGET_ID]: held } };
    const files = createFilesFake();
    const reader = createChatReaderFake(seed);
    const drive = createDriveReaderFake();
    const progress = createProgressFake();
    const deps = { reader, drive, files, ocr: OCR_OFF, clock: createClockFake(), logger: createLoggerFake(), progress, kbRoot: 'kb', timezone: 'UTC' };
    const convertFile = createConvertFile({ ...deps, reader: drive, progress: createProgressFake() });

    const running = createSyncChats({ ...deps, convertFile })({ dryRun: false, concurrency: 2, maxBytes: 1, all: true });
    for (let turn = 0; turn < 50 && !reader.calls.includes(`messages:${third.id}`); turn += 1) await Promise.resolve();

    expect(reader.calls).toContain(`messages:${third.id}`);
    expect(progress.steps).not.toContain('Budget review');

    release();
    expect((await running).ok).toBe(true);
    expect(progress.steps.toSorted(compareText)).toEqual(['Budget review', 'Jane Doe', 'Offsite']);
    expect(progress.dones).toHaveLength(1);
  });

  it('the state is saved as each chat ends, so a run that stops keeps what it filed', async () => {
    const { files } = await run({ input: { concurrency: 1 } });

    expect(files.writeLog.filter((path) => path === STATE_PATH)).toHaveLength(3);
    expect(files.writeLog.indexOf(STATE_PATH)).toBeLessThan(files.writeLog.indexOf(`${ROOT}/Jane Doe/2026-11-12.md`));
  });
});

const XLSX_URL = 'https://contoso-my.sharepoint.com/:x:/g/personal/jane_contoso_com/EaBcD';
const BUDGET_FILE = { name: 'Budget.xlsx', url: XLSX_URL };
const BUDGET_ITEM: DriveItem = {
  id: 'i1',
  name: 'Budget.xlsx',
  kind: 'file',
  size: 1200,
  path: '/Microsoft Teams Chat Files/Budget.xlsx',
  lastModified: '2026-11-13T08:00:00Z',
  cTag: 'c:{i1},7',
  webUrl: 'https://contoso-my.sharepoint.com/personal/jane_contoso_com/Documents/Microsoft%20Teams%20Chat%20Files/Budget.xlsx',
  modifiedBy: 'Jane Doe',
};
const LINKED = `${ROOT}/Budget review/2026-11-13/_linked`;

const withFile = (over: Partial<ChatReaderSeed> = {}): ChatReaderSeed => ({
  chats: [BUDGET, JANE],
  messages: { [BUDGET_ID]: [message('m2', '2026-11-13T09:00:00.0000000Z', { files: [BUDGET_FILE] })], [JANE_ID]: JANE_MESSAGES },
  links: { [XLSX_URL]: { url: BUDGET_ITEM.webUrl, driveId: 'd1', itemId: 'i1', name: 'Budget.xlsx' } },
  ...over,
});

describe('the files shared in a chat', () => {
  it('a shared file lands beside the note of its day with its text and its card, and the note links to it', async () => {
    const { summary, files, notes } = await run({ reader: withFile(), drive: { items: { i1: BUDGET_ITEM }, markdown: { i1: '| Line | Amount |' } } });

    expect(summary).toEqual({ ...NOTHING.summary, converted: 2 });
    expect(notes.failed).toStrictEqual([]);
    expect(files.written.get(`${LINKED}/Budget.xlsx.md`)).toContain('| Line | Amount |');
    expect(files.written.get(`${LINKED}/Budget.xlsx.md`)).toContain(`linked_from: ${'Chats/Budget review/2026-11-13.md'}`);
    expect(files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('message m2\n\n- [Budget.xlsx](2026-11-13/_linked/Budget.xlsx.md)\n');
    const day = stateOf(files).chats[BUDGET_ID]?.days['2026-11-13'];
    expect(day?.held).toContain(`${LINKED}/Budget.xlsx.md`);
    expect(day?.links).toEqual({ 'd1:i1': 'Budget.xlsx' });
    expect(day?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('each message of a day shows its own files, two files of one name each get a card, and a card says which message pointed at its file', async () => {
    const planUrl = 'https://contoso.sharepoint.com/sites/Finance/Shared Documents/Plan.docx';
    const twinUrl = 'https://contoso-my.sharepoint.com/:x:/g/personal/li_contoso_com/EzZz';
    const messages = [
      message('m2', '2026-11-13T09:00:00.0000000Z', { files: [BUDGET_FILE] }),
      message('m4', '2026-11-13T11:00:00.0000000Z', {
        files: [
          { name: 'Plan.docx', url: planUrl },
          { name: 'Budget.xlsx', url: twinUrl },
        ],
      }),
      message('m6', '2026-11-13T12:00:00.0000000Z'),
    ];
    const links = {
      [XLSX_URL]: { url: BUDGET_ITEM.webUrl, driveId: 'd1', itemId: 'i1', name: 'Budget.xlsx' },
      [planUrl]: { url: planUrl, driveId: 'd1', itemId: 'i2', name: 'Plan.docx' },
      [twinUrl]: { url: twinUrl, driveId: 'd2', itemId: 'i1', name: 'Budget.xlsx' },
    };
    const items = { i1: BUDGET_ITEM, i2: { ...BUDGET_ITEM, id: 'i2', name: 'Plan.docx', path: '/Plan.docx' } };

    const { files, notes } = await run({ reader: { chats: [BUDGET], messages: { [BUDGET_ID]: messages }, links }, drive: { items } });

    const note = files.written.get(`${ROOT}/Budget review/2026-11-13.md`) ?? '';
    const twin = /- \[Budget\.xlsx\]\(2026-11-13\/_linked\/(Budget[^)]+\.xlsx)\.md\)\n\n### 12:00/.exec(note)?.[1] ?? 'no second card';
    expect(notes.failed).toStrictEqual([]);
    expect(note).toContain(
      'message m2\n\n- [Budget.xlsx](2026-11-13/_linked/Budget.xlsx.md)\n\n### 11:00 · Jane Doe\n\nmessage m4\n\n- [Plan.docx](2026-11-13/_linked/Plan.docx.md)\n- [Budget.xlsx]('
    );
    expect(note.endsWith('### 12:00 · Jane Doe\n\nmessage m6\n')).toBe(true);
    expect(twin).not.toBe('Budget.xlsx');
    expect(files.written.get(`${LINKED}/${twin}.md`)).toContain('in_message: "2026-11-13T11:00:00.0000000Z"');
    expect(files.written.get(`${LINKED}/Plan.docx.md`)).toContain('in_message: "2026-11-13T11:00:00.0000000Z"');
    expect(files.written.get(`${LINKED}/Budget.xlsx.md`)).toContain('in_message: "2026-11-13T09:00:00.0000000Z"');
    expect(stateOf(files).chats[BUDGET_ID]?.days['2026-11-13']?.links).toEqual({ 'd1:i1': 'Budget.xlsx', 'd1:i2': 'Plan.docx', 'd2:i1': twin });
  });

  it('a file larger than the cap is left out, named in the report and in the note with why, and the day is not tried again for it', async () => {
    const big = { ...BUDGET_ITEM, size: 2 * 1024 * 1024 };

    const { summary, notes, files } = await run({ reader: withFile(), drive: { items: { i1: big } }, input: { maxBytes: 1024 * 1024 } });

    expect(summary).toEqual({ ...NOTHING.summary, converted: 2, skipped: 1 });
    expect(notes.skipped).toEqual([{ path: 'Budget review/2026-11-13: Budget.xlsx', reason: 'larger than the 1 MB cap' }]);
    expect(notes.failed).toStrictEqual([]);
    expect(files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('- [Budget.xlsx](2026-11-13/_linked/Budget.xlsx.md): larger than the 1 MB cap\n');
    expect(stateOf(files).chats[BUDGET_ID]?.days['2026-11-13']?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stateOf(files).retry).toBeUndefined();
  });

  it('a file the day held that is no longer on disk is passed over when its message goes, with nothing logged', async () => {
    const drive = { items: { i1: BUDGET_ITEM } };
    const first = await run({ reader: withFile(), drive });
    first.files.written.delete(`${LINKED}/Budget.xlsx.md`);
    const moved = chat({ lastMessageAt: '2026-11-13T11:00:00.0000000Z' });

    const second = await run({ onto: first.files, reader: withFile({ chats: [moved, JANE], messages: { [BUDGET_ID]: [message('m4', '2026-11-13T11:00:00.0000000Z')] } }), drive });

    expect(second.logger.calls.filter((call) => call.level === 'warn')).toStrictEqual([]);
    expect(stateOf(first.files).chats[BUDGET_ID]?.days['2026-11-13']?.held).toStrictEqual([]);
  });

  it('a file you cannot open is named in the report and in the note, the note is written, and the other chats land', async () => {
    const forbidden = { kind: 'permanent' as const, status: 403, message: '403 Forbidden' };

    const { summary, notes, files } = await run({ reader: withFile(), drive: { failItemReads: { i1: forbidden } } });

    expect(summary).toEqual({ ...NOTHING.summary, converted: 2, failed: 1 });
    expect(notes.failed).toEqual([{ path: 'Budget review/2026-11-13: Budget.xlsx', reason: 'permanent: 403 Forbidden' }]);
    expect(files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('- [Budget.xlsx](2026-11-13/_linked/Budget.xlsx.md): permanent: 403 Forbidden\n');
    expect(files.written.has(`${ROOT}/Jane Doe/2026-11-12.md`)).toBe(true);
    expect(stateOf(files).chats[BUDGET_ID]?.days['2026-11-13']?.hash).toBe('');
    expect(stateOf(files).retry?.[BUDGET_ID]?.attempts).toBe(1);
  });

  it('a file the source cannot place is named by its bare name with the reason, and the run after tries the chat again', async () => {
    const first = await run({ reader: withFile({ links: {} }) });

    expect(first.notes.failed).toEqual([{ path: 'Budget review/2026-11-13: Budget.xlsx', reason: 'permanent: Budget.xlsx is not a file in a library' }]);
    expect(first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('- Budget.xlsx: permanent: Budget.xlsx is not a file in a library\n');
    expect(first.logger.calls).toContainEqual({ level: 'warn', event: 'chat.file-unresolved', meta: { message: 'm2', cause: 'permanent' } });

    const second = await run({ onto: first.files, reader: withFile(), drive: { items: { i1: BUDGET_ITEM } } });

    expect(second.reader.calls).toContain(`messages:${BUDGET_ID}`);
    expect(second.notes.failed).toStrictEqual([]);
    expect(first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('- [Budget.xlsx](2026-11-13/_linked/Budget.xlsx.md)\n');
    expect(stateOf(first.files).retry).toBeUndefined();
  });

  it('a file the day holds at the version the source still has is not converted again when the day is written again', async () => {
    const drive = { items: { i1: BUDGET_ITEM } };
    const first = await run({ reader: withFile(), drive });
    const moved = chat({ lastMessageAt: '2026-11-13T11:00:00.0000000Z' });
    const messages = [message('m2', '2026-11-13T09:00:00.0000000Z', { files: [BUDGET_FILE] }), message('m4', '2026-11-13T11:00:00.0000000Z')];

    const second = await run({ onto: first.files, reader: withFile({ chats: [moved, JANE], messages: { [BUDGET_ID]: messages } }), drive });

    expect(first.drive.calls.filter((call) => call.startsWith('markdown:'))).toHaveLength(1);
    expect(second.drive.calls.filter((call) => call.startsWith('markdown:'))).toStrictEqual([]);
    expect(first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('- [Budget.xlsx](2026-11-13/_linked/Budget.xlsx.md)\n');
    expect(first.files.written.has(`${LINKED}/Budget.xlsx.md`)).toBe(true);
    expect(second.progress.details).toStrictEqual([]);
    expect(first.progress.details).toContainEqual({ label: 'Budget review', what: 'reading Budget.xlsx' });
  });

  it('a file the source cannot place this time, which the day pulled before, keeps what the day holds of it', async () => {
    const drive = { items: { i1: BUDGET_ITEM } };
    const first = await run({ reader: withFile(), drive });
    const versionsBefore = stateOf(first.files).chats[BUDGET_ID]?.days['2026-11-13']?.versions;
    const moved = chat({ lastMessageAt: '2026-11-13T11:00:00.0000000Z' });
    const messages = [message('m2', '2026-11-13T09:00:00.0000000Z', { files: [BUDGET_FILE] }), message('m4', '2026-11-13T11:00:00.0000000Z')];

    const second = await run({ onto: first.files, reader: withFile({ chats: [moved, JANE], messages: { [BUDGET_ID]: messages }, links: {} }), drive });

    expect(second.notes.failed).toHaveLength(1);
    expect(first.files.written.has(`${LINKED}/Budget.xlsx.md`)).toBe(true);
    const day = stateOf(first.files).chats[BUDGET_ID]?.days['2026-11-13'];
    expect(day?.held).toContain(`${LINKED}/Budget.xlsx.md`);
    expect(day?.links).toEqual({ 'd1:i1': 'Budget.xlsx' });
    expect(Object.keys(versionsBefore ?? {})).toEqual(['d1:i1']);
    expect(day?.versions).toEqual(versionsBefore);
  });

  it('a file whose message is gone from the day goes under the archive with its card', async () => {
    const drive = { items: { i1: BUDGET_ITEM } };
    const first = await run({ reader: withFile(), drive });
    const moved = chat({ lastMessageAt: '2026-11-13T11:00:00.0000000Z' });

    await run({ onto: first.files, reader: withFile({ chats: [moved, JANE], messages: { [BUDGET_ID]: [message('m4', '2026-11-13T11:00:00.0000000Z')] } }), drive });

    expect(first.files.written.has(`${LINKED}/Budget.xlsx.md`)).toBe(false);
    expect(first.files.written.has('kb/_archive/2026-11-14/Chats/Budget review/2026-11-13/_linked/Budget.xlsx.md')).toBe(true);
    expect(stateOf(first.files).chats[BUDGET_ID]?.days['2026-11-13']?.held).toStrictEqual([]);
  });
});

const PICTURE = `${ROOT}/Budget review/2026-11-13/_inline/m2-1.png`;

const withPicture = (over: Partial<ChatReaderSeed> = {}): ChatReaderSeed => ({
  chats: [BUDGET],
  messages: { [BUDGET_ID]: [message('m2', '2026-11-13T09:00:00.0000000Z', { text: `Look ${pictureMarker(0)}`, pictures: 1 })] },
  pictures: { m2: [{ path: 'image-1.png', bytes: new Uint8Array([1, 2, 3]) }] },
  ...over,
});

describe('the pictures pasted in a chat', () => {
  it('a pasted picture is saved beside the note of its day, and the note shows it where it stood', async () => {
    const { files, notes } = await run({ reader: withPicture(), ocr: 'off' });

    expect(notes.failed).toStrictEqual([]);
    expect(files.binary.get(PICTURE)).toEqual(new Uint8Array([1, 2, 3]));
    expect(files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('Look ![picture](2026-11-13/_inline/m2-1.png)\n');
    expect(stateOf(files).chats[BUDGET_ID]?.days['2026-11-13']?.held).toEqual([PICTURE]);
  });

  it('with OCR on, what it read is under the message, and the progress line says the picture is read', async () => {
    const { files, progress } = await run({ reader: withPicture(), ocr: { texts: { [PICTURE]: ' Total 42 \n' } } });

    expect(files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('Look ![picture](2026-11-13/_inline/m2-1.png)\n\nText in picture 1:\n\n> Total 42\n');
    expect(progress.details).toEqual([{ label: 'Budget review', what: 'reading m2-1.png' }]);
  });

  it('with OCR off, the picture is saved and linked with no reading, and the progress line says it is saved', async () => {
    const { files, progress } = await run({ reader: withPicture(), ocr: 'off' });

    expect(files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).not.toContain('Text in picture');
    expect(progress.details).toEqual([{ label: 'Budget review', what: 'saving m2-1.png' }]);
  });

  it('a picture the day holds is not fetched again when the day is written again, and a picture with no extension is saved without one', async () => {
    const bare = withPicture({ pictures: { m2: [{ path: 'image-1', bytes: new Uint8Array([7]) }] } });
    const first = await run({ reader: bare, ocr: 'off' });
    const moved = chat({ lastMessageAt: '2026-11-13T11:00:00.0000000Z' });
    const messages = [...(bare.messages?.[BUDGET_ID] ?? []), message('m4', '2026-11-13T11:00:00.0000000Z')];

    const second = await run({ onto: first.files, reader: { ...bare, chats: [moved], messages: { [BUDGET_ID]: messages } }, ocr: 'off' });

    expect(first.files.binary.has(`${ROOT}/Budget review/2026-11-13/_inline/m2-1`)).toBe(true);
    expect(second.reader.calls.filter((call) => call.startsWith('pictures:'))).toStrictEqual([]);
    expect(first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('Look ![picture](2026-11-13/_inline/m2-1)\n');
  });

  it('a message id or a picture extension that holds a path separator names a file inside the folder of the day, never one outside it', async () => {
    const odd = message('../../outside', '2026-11-13T09:00:00.0000000Z', { text: pictureMarker(0), pictures: 1 });
    const seed = withPicture({ messages: { [BUDGET_ID]: [odd] }, pictures: { '../../outside': [{ path: 'image-1.p/ng', bytes: new Uint8Array([1]) }] } });

    const { files } = await run({ reader: seed, ocr: 'off' });

    const inline = `${ROOT}/Budget review/2026-11-13/_inline/`;
    const saved = [...files.binary.keys()];
    expect(saved).toHaveLength(1);
    expect(saved[0]?.startsWith(inline)).toBe(true);
    expect(saved[0]?.slice(inline.length)).not.toContain('/');
  });

  it('two messages of a day each keep their own picture, and neither is fetched again when the day is written again', async () => {
    const both = [
      message('m2', '2026-11-13T09:00:00.0000000Z', { text: `First ${pictureMarker(0)}`, pictures: 1 }),
      message('m3', '2026-11-13T10:00:00.0000000Z', { text: `Second ${pictureMarker(0)}`, pictures: 1 }),
    ];
    const pictures = { m2: [{ path: 'image-1.png', bytes: new Uint8Array([2]) }], m3: [{ path: 'image-1.jpg', bytes: new Uint8Array([3]) }] };
    const first = await run({ reader: { chats: [BUDGET], messages: { [BUDGET_ID]: both }, pictures }, ocr: 'off' });
    const moved = chat({ lastMessageAt: '2026-11-13T11:00:00.0000000Z' });

    const second = await run({
      onto: first.files,
      reader: { chats: [moved], messages: { [BUDGET_ID]: [...both, message('m4', '2026-11-13T11:00:00.0000000Z')] }, pictures },
      ocr: 'off',
    });

    const note = first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`) ?? '';
    expect(first.reader.calls.filter((call) => call.startsWith('pictures:'))).toEqual(['pictures:m2', 'pictures:m3']);
    expect(second.reader.calls.filter((call) => call.startsWith('pictures:'))).toStrictEqual([]);
    expect(note).toContain('First ![picture](2026-11-13/_inline/m2-1.png)\n');
    expect(note).toContain('Second ![picture](2026-11-13/_inline/m3-1.jpg)\n');
    expect(stateOf(first.files).chats[BUDGET_ID]?.days['2026-11-13']?.held).toEqual([PICTURE, `${ROOT}/Budget review/2026-11-13/_inline/m3-1.jpg`]);
  });

  it('a day whose messages are all gone goes under the archive with the pictures it kept', async () => {
    const first = await run({ reader: withPicture(), ocr: 'off' });
    const moved = chat({ lastMessageAt: '2026-11-14T00:30:00.0000000Z' });

    await run({ onto: first.files, reader: withPicture({ chats: [moved], messages: { [BUDGET_ID]: [message('m5', '2026-11-14T00:30:00.0000000Z')] } }), ocr: 'off' });

    expect(first.files.binary.has(PICTURE)).toBe(false);
    expect(first.files.binary.has('kb/_archive/2026-11-14/Chats/Budget review/2026-11-13/_inline/m2-1.png')).toBe(true);
    expect(first.files.written.has('kb/_archive/2026-11-14/Chats/Budget review/2026-11-13.md')).toBe(true);
  });

  it('a picture that does not download is named in the report and in the note, the note is written, and the next run fetches it', async () => {
    const first = await run({ reader: withPicture({ failPicturesOf: ['m2'] }), ocr: 'off' });

    expect(first.summary).toEqual({ ...NOTHING.summary, converted: 1, failed: 1 });
    expect(first.notes.failed).toEqual([{ path: 'Budget review/2026-11-13: a picture of Jane Doe', reason: 'transient: cannot fetch the pictures of m2' }]);
    expect(first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('Look \\[picture not saved\\]\n');
    expect(first.logger.calls).toContainEqual({ level: 'warn', event: 'chat.picture-failed', meta: { message: 'm2' } });

    const second = await run({ onto: first.files, reader: withPicture(), ocr: 'off' });

    expect(second.notes.failed).toStrictEqual([]);
    expect(first.files.binary.has(PICTURE)).toBe(true);
    expect(first.files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('Look ![picture](2026-11-13/_inline/m2-1.png)\n');
  });

  it('a picture the source does not hand back, or the disk refuses, is named with why, and the others of the message are kept', async () => {
    const two = message('m2', '2026-11-13T09:00:00.0000000Z', { text: `${pictureMarker(0)} and ${pictureMarker(1)}`, pictures: 2 });
    const short = await run({ reader: withPicture({ messages: { [BUDGET_ID]: [two] } }), ocr: 'off' });
    const refused = await run({ reader: withPicture(), ocr: 'off', files: { failByteWritesMatching: '_inline' } });

    expect(short.notes.failed).toEqual([{ path: 'Budget review/2026-11-13: a picture of Jane Doe', reason: 'the source did not hand it back' }]);
    expect(short.files.written.get(`${ROOT}/Budget review/2026-11-13.md`)).toContain('![picture](2026-11-13/_inline/m2-1.png) and \\[picture not saved\\]\n');
    expect(stateOf(short.files).chats[BUDGET_ID]?.days['2026-11-13']?.held).toEqual([PICTURE]);
    expect(refused.notes.failed).toEqual([{ path: 'Budget review/2026-11-13: a picture of Jane Doe', reason: `cannot write ${PICTURE}` }]);
  });
});
