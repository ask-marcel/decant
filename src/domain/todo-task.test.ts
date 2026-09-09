import { describe, expect, it } from 'bun:test';
import { parseTodoTask } from './todo-task.ts';

const graphTask = {
  '@odata.etag': 'W/"gHYcqBAAAA=="',
  id: 'AAMkAGI-task',
  title: 'Book the venue',
  status: 'completed',
  importance: 'high',
  isReminderOn: false,
  createdDateTime: '2026-08-01T09:00:00.0000000Z',
  lastModifiedDateTime: '2026-09-08T16:20:11.0000000Z',
  body: { content: 'Ask for the September rate.', contentType: 'text' },
  dueDateTime: { dateTime: '2026-09-12T00:00:00.0000000', timeZone: 'UTC' },
  completedDateTime: { dateTime: '2026-09-08T00:00:00.0000000', timeZone: 'UTC' },
  categories: ['Work'],
  checklistItems: [
    { id: 's1', displayName: 'Shortlist three', isChecked: true },
    { id: 's2', displayName: 'Call them', isChecked: false },
  ],
  linkedResources: [{ id: 'l1', webUrl: 'https://tenant.sharepoint.com/sites/X/Contract.docx', applicationName: 'Microsoft Word', displayName: 'Contract draft' }],
};

describe('reading a Microsoft To Do task as Graph answers for it', () => {
  it('a task carries what names it, what dates it, what it says, and the steps and links hanging off it', () => {
    expect(parseTodoTask(graphTask)).toEqual({
      id: 'AAMkAGI-task',
      title: 'Book the venue',
      status: 'completed',
      importance: 'high',
      notes: 'Ask for the September rate.',
      created: '2026-08-01T09:00:00.0000000Z',
      lastModified: '2026-09-08T16:20:11.0000000Z',
      due: '2026-09-12',
      completed: '2026-09-08',
      categories: ['Work'],
      steps: [
        { text: 'Shortlist three', done: true },
        { text: 'Call them', done: false },
      ],
      links: [{ name: 'Contract draft', url: 'https://tenant.sharepoint.com/sites/X/Contract.docx', application: 'Microsoft Word' }],
    });
  });

  it('a due date and a completion date are days, since To Do has no time of day for either, and the zone they were entered in is dropped with the rest of the pair', () => {
    const parsed = parseTodoTask({ ...graphTask, dueDateTime: { dateTime: '2026-12-31T00:00:00.0000000', timeZone: 'Asia/Shanghai' } });

    expect(parsed?.due).toBe('2026-12-31');
  });

  it('a task with no id is no task, since nothing could be fetched or filed under it', () => {
    expect(parseTodoTask({ title: 'No id here' })).toBeUndefined();
    expect(parseTodoTask('not a record')).toBeUndefined();
  });

  it('a bare task, with no notes, no dates, no category and nothing expanded, is still a task', () => {
    expect(parseTodoTask({ id: 'AAMkAGI-bare', title: 'Water the plants', status: 'notStarted' })).toEqual({
      id: 'AAMkAGI-bare',
      title: 'Water the plants',
      status: 'notStarted',
      importance: 'normal',
      notes: '',
      created: '',
      lastModified: '',
      due: '',
      completed: '',
      categories: [],
      steps: [],
      links: [],
    });
  });

  it('a task Graph answered with an id and nothing else is blank in every field, never holed', () => {
    expect(parseTodoTask({ id: 'AAMkAGI-blank' })).toEqual({
      id: 'AAMkAGI-blank',
      title: '',
      status: '',
      importance: 'normal',
      notes: '',
      created: '',
      lastModified: '',
      due: '',
      completed: '',
      categories: [],
      steps: [],
      links: [],
    });
  });

  it('a body Graph sent as something other than a record leaves the notes empty rather than ending the read', () => {
    expect(parseTodoTask({ ...graphTask, body: 'just a string' })?.notes).toBe('');
  });

  it('a checklist and a link collection Graph sent as something other than arrays read as none of each', () => {
    const parsed = parseTodoTask({ ...graphTask, checklistItems: 'not an array', linkedResources: 7, categories: 'Work' });

    expect(parsed?.steps).toHaveLength(0);
    expect(parsed?.links).toHaveLength(0);
    expect(parsed?.categories).toHaveLength(0);
  });

  it('a step Graph answered without a name, and a link with no address, are dropped rather than written as blanks', () => {
    const parsed = parseTodoTask({
      ...graphTask,
      checklistItems: [{ id: 's1', isChecked: true }, 'not a record'],
      linkedResources: [{ id: 'l1', displayName: 'Nowhere' }],
    });

    expect(parsed?.steps).toHaveLength(0);
    expect(parsed?.links).toHaveLength(0);
  });

  it('a category list Graph answered with something other than strings keeps only the strings', () => {
    expect(parseTodoTask({ ...graphTask, categories: ['Work', 7, null] })?.categories).toEqual(['Work']);
  });
});
