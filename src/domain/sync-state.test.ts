import { describe, expect, it } from 'bun:test';
import { parseSyncedSource, sourceKey, sourceLabel } from './sync-state.ts';

describe('reading the sync state left by a previous run', () => {
  it('a site synced yesterday is reported with its name and how many files it holds', () => {
    const state = {
      version: 1,
      source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso' },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!one': { items: { a: {}, b: {} } }, 'b!two': { items: { c: {} } } },
    };

    const parsed = parseSyncedSource(state);

    expect(parsed).toEqual({ ok: true, value: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 3 } });
  });

  it('a site keeps the address it was synced from, so an update files it where the first run did', () => {
    const state = { source: { kind: 'site', id: 'contoso,3,4', name: 'Loop - Offsite', webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_one' } };

    const parsed = parseSyncedSource(state);

    expect(parsed.ok && parsed.value.webUrl).toBe('https://tenant.sharepoint.com/contentstorage/CSP_one');
  });

  it('a synced mailbox is counted by its conversations, one file each', () => {
    const state = { source: { kind: 'mailbox', id: 'me', name: 'Mailbox' }, lastRun: '2026-07-22T09:00:00Z', threads: { 'conv-1': {}, 'conv-2': {} } };

    expect(parseSyncedSource(state)).toEqual({ ok: true, value: { kind: 'mailbox', id: 'me', name: 'Mailbox', lastRun: '2026-07-22T09:00:00Z', fileCount: 2 } });
  });

  it('a source that has never completed a run reports no files and no last run', () => {
    const parsed = parseSyncedSource({ source: { kind: 'mailbox', id: 'me', name: 'Mailbox' } });

    expect(parsed).toEqual({ ok: true, value: { kind: 'mailbox', id: 'me', name: 'Mailbox', lastRun: 'never', fileCount: 0 } });
  });

  it('a state file holding something other than an object is rejected as malformed', () => {
    const parsed = parseSyncedSource('not a state');

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'sync state is not an object' } });
  });

  it('an empty state file that parsed to nothing is rejected as malformed', () => {
    const parsed = parseSyncedSource(null);

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'sync state is not an object' } });
  });

  it('a state file with no source block is rejected as malformed', () => {
    const parsed = parseSyncedSource({ version: 1 });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'sync state has no source object' } });
  });

  it('a group inbox is a source like the others, and its threads are counted the same way', () => {
    const state = { source: { kind: 'group', id: '0d3b-group', name: 'Northwind Leadership Team' }, lastRun: '2026-09-06T09:00:00Z', threads: { 'thread-1': {}, 'thread-2': {} } };

    expect(parseSyncedSource(state)).toEqual({
      ok: true,
      value: { kind: 'group', id: '0d3b-group', name: 'Northwind Leadership Team', lastRun: '2026-09-06T09:00:00Z', fileCount: 2 },
    });
  });

  it('a To Do list is a source like the others, and its tasks are counted one file each', () => {
    const state = { source: { kind: 'todo', id: 'list-1', name: 'Tasks' }, lastRun: '2026-09-09T09:00:00Z', tasks: { 'task-1': {}, 'task-2': {}, 'task-3': {} } };

    expect(parseSyncedSource(state)).toEqual({ ok: true, value: { kind: 'todo', id: 'list-1', name: 'Tasks', lastRun: '2026-09-09T09:00:00Z', fileCount: 3 } });
  });

  it('a team is a source like a site, counting the posts its channels hold the way a site counts its libraries', () => {
    const state = {
      source: { kind: 'team', id: 'team-1', name: 'Northwind Leadership' },
      lastRun: '2026-09-10T09:00:00Z',
      channels: { c1: { posts: { a: {}, b: {} } }, c2: { posts: { c: {} } }, bad: 'x' },
    };

    expect(parseSyncedSource(state)).toEqual({ ok: true, value: { kind: 'team', id: 'team-1', name: 'Northwind Leadership', lastRun: '2026-09-10T09:00:00Z', fileCount: 3 } });
  });

  it('the people directory is a source like the mailbox, counting its people one file each', () => {
    const state = { source: { kind: 'people', id: 'people', name: 'People' }, lastRun: '2026-09-11T09:00:00Z', people: { a: {}, b: {} } };

    expect(parseSyncedSource(state)).toEqual({ ok: true, value: { kind: 'people', id: 'people', name: 'People', lastRun: '2026-09-11T09:00:00Z', fileCount: 2 } });
  });

  it('the calendar is a source like the mailbox, counting its events one file each', () => {
    const state = { source: { kind: 'calendar', id: 'calendar', name: 'Calendar' }, lastRun: '2026-09-12T09:00:00Z', events: { a: {}, b: {}, c: {} } };

    expect(parseSyncedSource(state)).toEqual({ ok: true, value: { kind: 'calendar', id: 'calendar', name: 'Calendar', lastRun: '2026-09-12T09:00:00Z', fileCount: 3 } });
  });

  it('a notebook is a source like the others, counting its pages one file each', () => {
    const state = { source: { kind: 'notebook', id: '1-nb', name: 'Northwind Leadership Notebook' }, lastRun: '2026-09-12T09:00:00Z', pages: { a: {}, b: {} } };

    expect(parseSyncedSource(state)).toEqual({
      ok: true,
      value: { kind: 'notebook', id: '1-nb', name: 'Northwind Leadership Notebook', lastRun: '2026-09-12T09:00:00Z', fileCount: 2 },
    });
  });

  it('a plan is a source like a To Do list, counting its tasks one file each', () => {
    const state = { source: { kind: 'plan', id: 'plan-1', name: 'Offsite 2026' }, lastRun: '2026-09-12T09:00:00Z', tasks: { a: {}, b: {}, c: {} } };

    expect(parseSyncedSource(state)).toEqual({ ok: true, value: { kind: 'plan', id: 'plan-1', name: 'Offsite 2026', lastRun: '2026-09-12T09:00:00Z', fileCount: 3 } });
  });

  it('a site`s lists are a source of their own, counting the lists one table each', () => {
    const state = { source: { kind: 'lists', id: 'site-1', name: 'Espace Contoso' }, lastRun: '2026-09-12T09:00:00Z', lists: { a: {}, b: {} } };

    expect(parseSyncedSource(state)).toEqual({ ok: true, value: { kind: 'lists', id: 'site-1', name: 'Espace Contoso', lastRun: '2026-09-12T09:00:00Z', fileCount: 2 } });
  });

  it('a source naming a kind this tool cannot sync is rejected as malformed', () => {
    const parsed = parseSyncedSource({ source: { kind: 'whiteboard', id: 'x', name: 'y' } });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'unknown source kind: whiteboard' } });
  });

  it('a source missing its id is rejected as malformed', () => {
    const parsed = parseSyncedSource({ source: { kind: 'site', name: 'Espace Contoso' } });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'source is missing id or name' } });
  });

  it('a source missing its name is rejected as malformed', () => {
    const parsed = parseSyncedSource({ source: { kind: 'site', id: 'contoso,1,2' } });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'source is missing id or name' } });
  });

  it('a source whose id was written as a number is rejected as malformed', () => {
    const parsed = parseSyncedSource({ source: { kind: 'site', id: 42, name: 'Espace Contoso' } });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'source is missing id or name' } });
  });

  it('drives recorded without an item map contribute no files to the count', () => {
    const parsed = parseSyncedSource({ source: { kind: 'site', id: 'a', name: 'b' }, drives: { 'b!one': {}, 'b!two': 'broken', 'b!three': null } });

    expect(parsed.ok && parsed.value.fileCount).toBe(0);
  });
});

describe('naming a source in a report', () => {
  it('a group inbox is named apart from the site that shares its name', () => {
    expect(sourceLabel({ name: 'Northwind Projects 2026', kind: 'group' })).toBe('Northwind Projects 2026 (group inbox)');
    expect(sourceLabel({ name: 'Northwind Projects 2026', kind: 'site' })).toBe('Northwind Projects 2026');
  });

  it('the mailbox is named as it calls itself', () => {
    expect(sourceLabel({ name: 'Mailbox', kind: 'mailbox' })).toBe('Mailbox');
  });

  it('a site`s lists are named apart from the site`s libraries, which carry the same name', () => {
    expect(sourceLabel({ name: 'Northwind Projects 2026', kind: 'lists' })).toBe('Northwind Projects 2026 (lists)');
  });
});

describe('telling sources apart wherever every kind is held together', () => {
  it('a source is known by its id, except a site`s lists, which carry the site`s own id and are told from its libraries by their kind', () => {
    expect(sourceKey({ kind: 'site', id: 'contoso,1,2' })).toBe('contoso,1,2');
    expect(sourceKey({ kind: 'lists', id: 'contoso,1,2' })).toBe('lists:contoso,1,2');
    expect(sourceKey({ kind: 'group', id: 'g-1' })).toBe('g-1');
  });
});
