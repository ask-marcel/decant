import { describe, expect, it } from 'bun:test';
import {
  countThreads,
  emptyMailboxState,
  needsRender,
  parseMailboxState,
  serializeMailboxState,
  withAttachment,
  withFolderCursor,
  withLinked,
  withPending,
  withThread,
} from './mail-state.ts';

const thread = { file: 'threads/2026/2026-05-12 Contrat a3f9c1.md', messageIds: ['m1', 'm2'], lastMessage: '2026-05-13T10:00:00Z', attachments: ['a.pdf'] };

describe('remembering where a mailbox sync got to', () => {
  it('a mailbox never synced starts with no folders, threads or queue', () => {
    expect(emptyMailboxState()).toEqual({
      version: 1,
      source: { kind: 'mailbox', id: 'me', name: 'Mailbox' },
      lastRun: '',
      folders: {},
      threads: {},
      linked: {},
      attachments: {},
      pending: [],
    });
  });

  it('what one run writes, the next run reads back unchanged', () => {
    const linked = withLinked(withThread(withFolderCursor(emptyMailboxState(), 'AAMk1', 'Inbox', 'cursor-1'), 'conv-1', thread), 'b!one:01ABC', {
      paths: ['_linked/Contrat.docx.md'],
    });
    const state = withAttachment(linked, 'ba7816bf8f01', { name: 'Contrat.docx', paths: ['_attachments/Contrat.docx.md'] });

    expect(parseMailboxState(JSON.parse(serializeMailboxState(state)))).toEqual({ ok: true, value: state });
  });

  it('a state file written before the shared attachment store still loads', () => {
    const parsed = parseMailboxState({ source: { kind: 'mailbox' } });

    expect(parsed.ok && parsed.value.attachments).toEqual({});
  });

  it('an attachment stored once is recorded by its content address, under the name it was stored as', () => {
    const state = withAttachment(emptyMailboxState(), 'ba7816bf8f01', { name: 'Scan.pdf', paths: ['_attachments/Scan.pdf', '_attachments/Scan.pdf.md'] });

    expect(state.attachments['ba7816bf8f01']).toEqual({ name: 'Scan.pdf', paths: ['_attachments/Scan.pdf', '_attachments/Scan.pdf.md'] });
  });

  it('a folder swept for the first time is recorded even before it has a cursor', () => {
    const state = withFolderCursor(emptyMailboxState(), 'AAMk1', 'Inbox', undefined);

    expect(state.folders['AAMk1']).toEqual({ name: 'Inbox' });
  });

  it('a state file belonging to a site is not mistaken for a mailbox', () => {
    expect(parseMailboxState({ source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is not a mailbox' },
    });
    expect(parseMailboxState('nope')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
  });

  it('a state file written by an older version without threads still loads', () => {
    const parsed = parseMailboxState({ source: { kind: 'mailbox' } });

    expect(parsed.ok && parsed.value).toEqual(emptyMailboxState());
  });

  it('a mailbox that recorded its own name and address keeps them', () => {
    const parsed = parseMailboxState({ source: { kind: 'mailbox', id: 'vincent@example.com', name: 'Vincent inbox' } });

    expect(parsed.ok && parsed.value.source).toEqual({ kind: 'mailbox', id: 'vincent@example.com', name: 'Vincent inbox' });
  });

  it('a run date recorded as something other than text reads as never run', () => {
    const parsed = parseMailboxState({ source: { kind: 'mailbox' }, lastRun: 20260722 });

    expect(parsed.ok && parsed.value.lastRun).toBe('');
  });

  it('a conversation recorded without the file it produced still loads', () => {
    const parsed = parseMailboxState({ source: { kind: 'mailbox' }, threads: { 'conv-1': { messageIds: ['m1'] } } });

    expect(parsed.ok && parsed.value.threads['conv-1']).toEqual({ file: '', messageIds: ['m1'], lastMessage: '', attachments: [] });
  });

  it('entries recorded half-written load with what they do have rather than failing the run', () => {
    const parsed = parseMailboxState({
      source: { kind: 'mailbox' },
      folders: { AAMk1: 'broken' },
      threads: { 'conv-1': { file: 'x.md', messageIds: ['m1', 7] } },
      pending: ['conv-1', 9],
    });

    expect(parsed.ok && parsed.value.folders).toEqual({});
    expect(parsed.ok && parsed.value.threads['conv-1']).toEqual({ file: 'x.md', messageIds: ['m1'], lastMessage: '', attachments: [] });
    expect(parsed.ok && parsed.value.pending).toEqual(['conv-1']);
  });

  it('the queue can be replaced as conversations are finished', () => {
    expect(withPending(emptyMailboxState(), ['conv-1', 'conv-2']).pending).toEqual(['conv-1', 'conv-2']);
  });

  it('the picker counts one file per conversation', () => {
    expect(countThreads(withThread(emptyMailboxState(), 'conv-1', thread))).toBe(1);
  });
});

describe('deciding whether a conversation has to be written again', () => {
  const state = withThread(emptyMailboxState(), 'conv-1', thread);

  it('a conversation never seen before is written', () => {
    expect(needsRender(state, 'conv-new', ['m9'])).toBe(true);
  });

  it('a conversation that gained a reply is written again', () => {
    expect(needsRender(state, 'conv-1', ['m1', 'm2', 'm3'])).toBe(true);
  });

  it('a conversation whose messages are all known is left alone, whatever the sweep resurfaced', () => {
    expect(needsRender(state, 'conv-1', ['m1', 'm2'])).toBe(false);
    expect(needsRender(state, 'conv-1', ['m2'])).toBe(false);
    expect(needsRender(state, 'conv-1', [])).toBe(false);
  });
});
