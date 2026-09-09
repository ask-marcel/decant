import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';
import { createTodoReaderFromCall } from './todo-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createTodoReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createTodoReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const answer = answers[name]?.[at] ?? answers[name]?.[0] ?? ok({});
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

const TASK = {
  id: 'AAMkAGI-task',
  title: 'Book the venue',
  status: 'notStarted',
  importance: 'normal',
  lastModifiedDateTime: '2026-09-08T16:20:11Z',
};

describe('reading Microsoft To Do through the ask-marcel library', () => {
  it('the lists Graph answers with become the lists the picker can offer', async () => {
    const { reader } = readerFor({
      'list-todo-task-lists': [
        ok({ value: [{ id: 'list-1', displayName: 'Tasks', wellknownListName: 'defaultList' }, { id: 'list-2', displayName: 'Flagged Emails' }, { name: 'no id here' }] }),
      ],
    });

    expect(await reader.taskLists()).toEqual({
      ok: true,
      value: [
        { id: 'list-1', name: 'Tasks' },
        { id: 'list-2', name: 'Flagged Emails' },
      ],
    });
  });

  it('a list Graph named with nothing is still offered, under its id, so it is choosable at all', async () => {
    const { reader } = readerFor({ 'list-todo-task-lists': [ok({ value: [{ id: 'list-9' }] })] });

    expect(await reader.taskLists()).toEqual({ ok: true, value: [{ id: 'list-9', name: 'list-9' }] });
  });

  it('a list that cannot be read fails rather than reading as an account with no lists', async () => {
    const { reader } = readerFor({ 'list-todo-task-lists': [err({ type: 'auth_failed', message: 'sign-in has lapsed' })] });

    expect(await reader.taskLists()).toEqual({ ok: false, error: { kind: 'permanent', message: 'sign-in has lapsed' } });
  });

  it('the tasks are asked for with their steps and their links, which a bare listing leaves out', async () => {
    const { reader, recorded } = readerFor({ 'list-todo-tasks': [ok({ value: [TASK] })] });

    const tasks = await reader.tasks('list-1');

    expect(tasks.ok && tasks.value.map((task) => task.title)).toEqual(['Book the venue']);
    expect(recorded[0]?.params).toMatchObject({ todoTaskListId: 'list-1', expand: 'checklistItems,linkedResources' });
  });

  it('a listing answered a page at a time is followed to its end before the tasks are handed back', async () => {
    const { reader, recorded } = readerFor({
      'list-todo-tasks': [ok({ value: [TASK], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-1/tasks?%24skiptoken=abc' })],
      'next-page': [ok({ value: [{ ...TASK, id: 'AAMkAGI-second', title: 'Water the plants' }] })],
    });

    const tasks = await reader.tasks('list-1');

    expect(tasks.ok && tasks.value.map((task) => task.id)).toEqual(['AAMkAGI-task', 'AAMkAGI-second']);
    expect(recorded[1]).toEqual({ name: 'next-page', params: { url: 'https://graph.microsoft.com/v1.0/me/todo/lists/list-1/tasks?$skiptoken=abc' } });
  });

  it('a cursor pointing back at itself ends the paging rather than looping on it forever', async () => {
    const looping = ok({ value: [TASK], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/loop' });
    const { reader, recorded } = readerFor({ 'list-todo-tasks': [looping], 'next-page': [looping] });

    const tasks = await reader.tasks('list-1');

    expect(tasks.ok && tasks.value).toHaveLength(2);
    expect(recorded.filter((entry) => entry.name === 'next-page')).toHaveLength(1);
  });

  it('a page that fails part way through fails the read, rather than handing back half a list as a whole one', async () => {
    const { reader } = readerFor({
      'list-todo-tasks': [ok({ value: [TASK], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' })],
      'next-page': [err({ type: 'api_error', status: 503, message: 'Graph is busy' })],
    });

    expect(await reader.tasks('list-1')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph is busy' } });
  });
});
