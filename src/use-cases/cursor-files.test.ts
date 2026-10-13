import { describe, expect, it } from 'bun:test';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { withCursorFiles } from './cursor-files.ts';

const STATE = 'kb/Mailbox/.sync-state.json';
const CURSOR = 'kb/Mailbox/.sync-cursor.json';

const saved = {
  version: 1,
  source: { kind: 'mailbox', id: 'me', name: 'Mailbox' },
  lastRun: '2026-10-13T08:00:00Z',
  folders: { inbox: { name: 'Inbox', deltaLink: 'https://graph/delta?token=1' } },
  threads: {},
};

const asText = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

describe('keeping the run time and the cursors of a sync beside its state', () => {
  // The state then changes only when the source does, so a copy of the knowledge base (a backup,
  // git, OneDrive) sees no change from a run that found nothing new.
  it('a saved state leaves its run time and cursors in a file of their own, and is read back whole', async () => {
    const disk = createFilesFake();
    const files = withCursorFiles(disk);

    expect(await files.writeText(STATE, asText(saved))).toEqual({ ok: true, value: undefined });

    expect(JSON.parse(disk.written.get(STATE) ?? '')).toEqual({ version: 1, source: saved.source, folders: { inbox: { name: 'Inbox' } }, threads: {} });
    expect(JSON.parse(disk.written.get(CURSOR) ?? '').cursor).toEqual({ lastRun: saved.lastRun, folders: { inbox: { deltaLink: saved.folders.inbox.deltaLink } } });

    const read = await files.readText(STATE);

    expect(read.ok && JSON.parse(read.value)).toEqual(saved);
  });

  // A lost cursor costs one full listing of the source, and nothing it holds is written again.
  it('a state with no cursor beside it, or with the cursor of another state, is read as it is on disk', async () => {
    const disk = createFilesFake();
    const files = withCursorFiles(disk);
    await files.writeText(STATE, asText(saved));
    const onDisk = disk.written.get(STATE) ?? '';

    disk.written.set(STATE, onDisk.replace('"threads": {}', '"threads": { "t1": {} }'));

    expect(await files.readText(STATE)).toEqual({ ok: true, value: onDisk.replace('"threads": {}', '"threads": { "t1": {} }') });

    disk.written.set(STATE, onDisk);
    disk.written.delete(CURSOR);

    expect(await files.readText(STATE)).toEqual({ ok: true, value: onDisk });
    expect((await files.readText('kb/Mailbox/missing/.sync-state.json')).ok).toBe(false);
  });

  it('a state that cannot be saved leaves the cursor as it was, and one that is not JSON is saved as given', async () => {
    const refusing = createFilesFake({ failWritesMatching: '.sync-state.json' });

    expect((await withCursorFiles(refusing).writeText(STATE, asText(saved))).ok).toBe(false);
    expect(refusing.written.has(CURSOR)).toBe(false);

    const disk = createFilesFake();
    await withCursorFiles(disk).writeText(STATE, 'not json');

    expect(disk.written.get(STATE)).toBe('not json');
    expect(disk.written.has(CURSOR)).toBe(false);
  });

  // The cursor left on disk belongs to the state before, so the next run reads the source whole once:
  // a cost, never a reason to stop the source.
  it('a cursor that cannot be saved is logged, and the state saved before it still counts as saved', async () => {
    const refusing = createFilesFake({ failWritesMatching: '.sync-cursor.json' });
    const logger = createLoggerFake();

    expect(await withCursorFiles(refusing, logger).writeText(STATE, asText(saved))).toEqual({ ok: true, value: undefined });
    expect(refusing.written.has(STATE)).toBe(true);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'cursor.unsaved', meta: { path: CURSOR, cause: 'write-failed' } });
    expect((await withCursorFiles(refusing).writeText(STATE, asText(saved))).ok).toBe(true);
  });

  it('every other file is read and written as it is', async () => {
    const disk = createFilesFake();
    const files = withCursorFiles(disk);
    const note = asText({ lastRun: 'kept here' });

    await files.writeText('kb/Mailbox/_meta/threads.jsonl', note);

    expect(disk.written.get('kb/Mailbox/_meta/threads.jsonl')).toBe(note);
    expect(await files.readText('kb/Mailbox/_meta/threads.jsonl')).toEqual({ ok: true, value: note });
    expect(disk.written.size).toBe(1);
  });
});
