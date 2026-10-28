import { describe, expect, it } from 'bun:test';
import { emptyCalendarState, serializeCalendarState, withEvent } from '../domain/calendar-state.ts';
import { emptyGroupState, serializeGroupState, withGroupThread } from '../domain/group-state.ts';
import { emptyListsState, serializeListsState, withList } from '../domain/lists-state.ts';
import { emptyMailboxState, serializeMailboxState, withConversation, withThread } from '../domain/mail-state.ts';
import { emptyNotebookState, notebookRootName, serializeNotebookState, withPage } from '../domain/notebook-state.ts';
import { emptyPeopleState, serializePeopleState, withPerson } from '../domain/people-state.ts';
import { emptyPlanState, serializePlanState } from '../domain/plan-state.ts';
import { withTask as withPlanTask } from '../domain/plan-state.ts';
import { emptyTeamState, serializeTeamState, withPost } from '../domain/team-state.ts';
import { emptyTodoState, serializeTodoState, withTask } from '../domain/todo-state.ts';
import { createCalendarReaderFake } from '../test-helpers/calendar-reader-fake.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake } from '../test-helpers/files-fake.ts';
import { createGroupReaderFake } from '../test-helpers/group-reader-fake.ts';
import { createListReaderFake } from '../test-helpers/list-reader-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { createMailReaderFake } from '../test-helpers/mail-reader-fake.ts';
import { createNotebookReaderFake } from '../test-helpers/notebook-reader-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createPeopleReaderFake } from '../test-helpers/people-reader-fake.ts';
import { createPlanReaderFake } from '../test-helpers/plan-reader-fake.ts';
import { createPromptFake } from '../test-helpers/prompt-fake.ts';
import { createTeamReaderFake } from '../test-helpers/team-reader-fake.ts';
import { createTodoReaderFake } from '../test-helpers/todo-reader-fake.ts';
import { err } from '../domain/result.ts';
import type { DepOverrides } from './build-deps.ts';
import { buildDeps } from './build-deps.ts';
import { readConfig } from './config.ts';

// Each source the composition builds gets the aside ledger: a file it lets go that will not move under
// the archive is written down in `kb/.sync-aside.json`, so a later run moves it. One update for each
// source, with an item gone at the source and every move refused.
const LEDGER = 'kb/.sync-aside.json';
const HELD = { kind: 'write-failed', path: 'kb', message: 'EBUSY' } as const;

const update = async (files: FilesFake, overrides: Partial<DepOverrides>): Promise<ReadonlyArray<string>> => {
  const config = readConfig({ env: {}, ocrLang: 'en', interactive: false, timezone: '', machineTimezone: 'UTC' });
  await buildDeps(config, {
    files,
    logger: createLoggerFake(),
    reader: createDriveReaderFake(),
    mail: createMailReaderFake(),
    group: createGroupReaderFake(),
    todo: createTodoReaderFake(),
    team: createTeamReaderFake(),
    people: createPeopleReaderFake(),
    calendar: createCalendarReaderFake(),
    notebook: createNotebookReaderFake(),
    list: createListReaderFake(),
    plan: createPlanReaderFake(),
    ocr: createOcrFake(),
    prompt: createPromptFake(),
    clock: createClockFake('2026-10-18T09:00:00Z'),
    ...overrides,
  }).runSync({ command: 'update', driveIds: [], maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });
  return Object.keys(JSON.parse(files.written.get(LEDGER) ?? '{}'));
};

describe('a file a source lets go that will not move under the archive', () => {
  it('is written down for a task gone from a To Do list', async () => {
    const file = 'kb/To Do/Tasks/2026-09-01/Cancel the order.md';
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'gone', { file, lastModified: '2026-09-01T09:00:00Z', title: 'Cancel the order' });
    const files = createFilesFake({
      directories: { kb: ['To Do'], 'kb/To Do': ['Tasks'] },
      texts: { 'kb/To Do/Tasks/.sync-state.json': serializeTodoState(state), [file]: 'the task' },
      failMoveWith: HELD,
    });

    expect(await update(files, { todo: createTodoReaderFake({ tasks: { 'list-1': [] } }) })).toContain(file);
  });

  it('is written down for a post deleted in Teams', async () => {
    const file = 'kb/Teams/Northwind Leadership/General/2026-09-01/Post a.md';
    const state = withPost(emptyTeamState('team-1', 'Northwind Leadership'), 'ch-1', 'General', 'a', { file, lastModified: '2026-09-01T09:00:00Z', title: 'Post a' });
    const files = createFilesFake({
      directories: { kb: ['Teams'], 'kb/Teams': ['Northwind Leadership'] },
      texts: { 'kb/Teams/Northwind Leadership/.sync-state.json': serializeTeamState(state), [file]: 'the post' },
      failMoveWith: HELD,
    });
    const deleted = {
      id: 'a',
      subject: 'Post a',
      author: 'Jane Doe',
      created: '2026-09-01T09:00:00Z',
      lastModified: '2026-09-10T09:00:00Z',
      webUrl: '',
      preview: '',
      deleted: true,
    };

    expect(await update(files, { team: createTeamReaderFake({ posts: { 'ch-1': [deleted] } }) })).toContain(file);
  });

  it('is written down for an event deleted from the calendar', async () => {
    const file = 'kb/Calendar/2026-09-01/Cancelled call.md';
    const state = withEvent(emptyCalendarState(), 'gone', { file, lastModified: 'x', subject: 'Cancelled call', outputs: [file] });
    const files = createFilesFake({
      directories: { kb: ['Calendar'] },
      texts: { 'kb/Calendar/.sync-state.json': serializeCalendarState(state), [file]: 'the call' },
      failMoveWith: HELD,
    });

    expect(await update(files, { calendar: createCalendarReaderFake({ changes: [{ id: 'gone', removed: true }], deltaLink: 'next' }) })).toContain(file);
  });

  it('is written down for a list gone from its site', async () => {
    const root = 'kb/SharePoint lists/Espace Contoso';
    const file = `${root}/Retired.md`;
    const state = withList(emptyListsState('site-1', 'Espace Contoso'), 'gone', { file, fingerprint: 'x', name: 'Retired' });
    const files = createFilesFake({
      directories: { kb: ['SharePoint lists'], 'kb/SharePoint lists': ['Espace Contoso'] },
      texts: { [`${root}/.sync-state.json`]: serializeListsState(state), [file]: 'the list' },
      failMoveWith: HELD,
    });

    expect(await update(files, { list: createListReaderFake({ lists: { 'site-1': [] } }) })).toContain(file);
  });

  it('is written down for a task gone from a plan', async () => {
    const plan = { id: 'plan-1', title: 'Offsite 2026', groupId: 'g-1' };
    const file = 'kb/Planner/Offsite 2026/Done/Retired.md';
    const state = withPlanTask(emptyPlanState(plan), 'gone', { file, fingerprint: 'x', title: 'Retired' });
    const files = createFilesFake({
      directories: { kb: ['Planner'], 'kb/Planner': ['Offsite 2026'] },
      texts: { 'kb/Planner/Offsite 2026/.sync-state.json': serializePlanState(state), [file]: 'the task' },
      failMoveWith: HELD,
    });

    expect(await update(files, { plan: createPlanReaderFake({ plans: [plan], buckets: { 'plan-1': [] }, tasks: { 'plan-1': [] } }) })).toContain(file);
  });

  it('is written down for a page deleted from a notebook', async () => {
    const notebook = { id: 'nb-1', name: 'Northwind Notebook', webUrl: 'https://x/1', site: undefined };
    const root = notebookRootName(notebook.name);
    const file = `kb/${root}/Meetings/Deleted.md`;
    const state = withPage(emptyNotebookState(notebook), 'gone', { file, lastModified: 'x', title: 'Deleted', section: 'sec-m' });
    const files = createFilesFake({
      directories: { kb: ['OneNote'], 'kb/OneNote': [root.slice('OneNote/'.length)] },
      texts: { [`kb/${root}/.sync-state.json`]: serializeNotebookState(state), [file]: 'the page' },
      failMoveWith: HELD,
    });

    expect(await update(files, { notebook: createNotebookReaderFake({ sections: { 'nb-1': [] } }) })).toContain(file);
  });

  it('is written down for someone no longer in the directory', async () => {
    const file = 'kb/People/Left Already.md';
    const state = withPerson(emptyPeopleState(), 'gone', { file, name: 'Left Already', fingerprint: 'x' });
    const files = createFilesFake({
      directories: { kb: ['People'] },
      texts: { 'kb/People/.sync-state.json': serializePeopleState(state), [file]: 'the page' },
      failMoveWith: HELD,
    });
    const dana = { id: 'dana', name: 'Dana Farrow', title: '', department: '', email: 'dana@example.com', phones: [], office: '', enabled: true, member: true, manager: undefined };

    expect(
      await update(files, {
        team: createTeamReaderFake({ teams: [{ id: 'team-all', name: 'NORTHWIND EMPLOYEES' }] }),
        people: createPeopleReaderFake({ members: { 'team-all': [{ userId: 'dana', name: 'Dana Farrow' }] }, profiles: { dana } }),
      })
    ).toContain(file);
  });

  // A thread whose note moved leaves the state: a file of it that will not move is written down.
  it('is written down for a file of a mail thread with no message left', async () => {
    const folder = '2026-05-12-thread-1-contrat';
    const note = `kb/Mailbox/threads/${folder}/contrat.md`;
    const card = `kb/Mailbox/threads/${folder}/_attachments/a.pdf.md`;
    const record = {
      folder,
      conversationIds: ['conv-1'],
      file: `threads/${folder}/contrat.md`,
      messageIds: ['m0'],
      lastMessage: '2026-05-12T09:31:00Z',
      attachments: [],
      inlineImages: [],
      files: [card],
    };
    const state = withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<r@example.com>' }), 'thread-1', record);
    const fake = createFilesFake({ directories: { kb: ['Mailbox'] }, texts: { 'kb/Mailbox/.sync-state.json': serializeMailboxState(state), [note]: 'note', [card]: 'card' } });
    const files = { ...fake, move: async (from: string, to: string) => (from === card ? err(HELD) : fake.move(from, to)) };
    const removed = {
      id: 'm0',
      conversationId: '',
      subject: '',
      received: '2026-05-12T09:31:00Z',
      hasAttachments: false,
      from: { name: '', address: '' },
      to: [],
      isDeleted: true,
    };

    expect(
      await update(files, {
        mail: createMailReaderFake({ folders: [{ id: 'AAMk-inbox', name: 'Inbox', childCount: 0, itemCount: 5 }], pages: [{ messages: [removed], skipped: 0, deltaLink: 'c1' }] }),
      })
    ).toEqual([card]);
  });

  it('is written down for a file of a group thread the group no longer lists', async () => {
    const root = 'kb/Group inboxes/Northwind Leadership Team';
    const folder = '2026-07-20-abc1234567-bi-monthly-leadership-meeting';
    const note = `${root}/threads/${folder}/bi-monthly-leadership-meeting.md`;
    const card = `${root}/threads/${folder}/_attachments/a.pdf.md`;
    const record = {
      folder,
      conversationIds: ['0d3b-group|AAQkAD-thread'],
      file: `threads/${folder}/bi-monthly-leadership-meeting.md`,
      messageIds: ['0d3b-group|AAQkAD-thread|AAMkAD-post'],
      lastMessage: '2026-07-20T10:45:14Z',
      attachments: [],
      inlineImages: [],
      files: [card],
    };
    const state = withGroupThread(emptyGroupState('0d3b-group', 'Northwind Leadership Team'), 'AAQkAD-thread', record);
    const fake = createFilesFake({
      directories: { kb: ['Group inboxes'], 'kb/Group inboxes': ['Northwind Leadership Team'] },
      texts: { [`${root}/.sync-state.json`]: serializeGroupState(state), [note]: 'note', [card]: 'card' },
    });
    const files = { ...fake, move: async (from: string, to: string) => (from === card ? err(HELD) : fake.move(from, to)) };
    const other = { id: 'other', topic: 'Offsite agenda', lastDelivered: '2026-07-01T00:00:00Z', hasAttachments: false };

    expect(await update(files, { group: createGroupReaderFake({ threads: { '0d3b-group': [other] } }) })).toEqual([card]);
  });
});
