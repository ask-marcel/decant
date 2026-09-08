import { describe, expect, it } from 'bun:test';
import {
  GROUP_STATE_VERSION,
  emptyGroupState,
  groupRootName,
  parseGroupState,
  serializeGroupState,
  watermarkOf,
  withGroupRetry,
  withGroupThread,
  withoutGroupRetry,
} from './group-state.ts';
import type { ThreadRecord } from './mail-state.ts';

const record = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  folder: '2026-07-20-abc1234567-bi-monthly-leadership-meeting',
  conversationIds: ['AAQkAD-thread'],
  file: 'bi-monthly-leadership-meeting.md',
  messageIds: ['AAQkAD-thread|AAMkAD-post'],
  lastMessage: '2026-07-20T10:45:14Z',
  attachments: [],
  inlineImages: [],
  ...over,
});

describe('remembering what a group inbox run already filed', () => {
  it('a group is filed apart from the SharePoint site that shares its name', () => {
    expect(String(groupRootName('MOOV Leadership Team'))).toBe('MOOV Leadership Team (group inbox)');
  });

  it('a fresh state knows which group it is for and holds nothing yet', () => {
    expect(emptyGroupState('0d3b-group', 'MOOV Leadership Team')).toEqual({
      version: GROUP_STATE_VERSION,
      source: { kind: 'group', id: '0d3b-group', name: 'MOOV Leadership Team' },
      lastRun: '',
      threads: {},
      linked: {},
      attachments: {},
      retry: {},
    });
  });

  it('a state written out and read back holds the same threads', () => {
    const state = withGroupThread(emptyGroupState('0d3b-group', 'MOOV Leadership Team'), 'AAQkAD-thread', record());

    expect(parseGroupState(JSON.parse(serializeGroupState(state)))).toEqual({ ok: true, value: state });
  });

  it('a state from a version this code does not write is refused rather than half read', () => {
    const state = { ...emptyGroupState('0d3b-group', 'MOOV Leadership Team'), version: 99 };

    expect(parseGroupState(state)).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is version 99, not 1' } });
  });

  it('a mailbox state is not a group state, whatever else it holds', () => {
    expect(parseGroupState({ version: 1, source: { kind: 'mailbox', id: 'me', name: 'Mailbox' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is not a group inbox' },
    });
    expect(parseGroupState({ version: 1 })).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not a group inbox' } });
    expect(parseGroupState('not a state')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
  });

  it('a group state naming neither id nor name still parses, since the folder it sits in identifies it', () => {
    const parsed = parseGroupState({ version: GROUP_STATE_VERSION, source: { kind: 'group' } });

    expect(parsed).toEqual({ ok: true, value: { ...emptyGroupState('', ''), lastRun: '' } });
  });

  it('a state read back holds the files earlier runs already fetched, so nothing is pulled twice', () => {
    const written = {
      ...emptyGroupState('0d3b-group', 'MOOV Leadership Team'),
      linked: { 'https://tenant.sharepoint.com/sites/X/Spec.docx': { paths: ['_linked/2026-07-20/Spec.docx.md'] } },
      attachments: {
        'sha256-abc': { name: 'Deck.pptx', paths: ['_attachments/Deck.pptx.md', '_attachments/Deck.pptx.pdf'], primary: '_attachments/Deck.pptx.md', media: [], text: undefined },
      },
    };

    const parsed = parseGroupState(JSON.parse(serializeGroupState(written)));

    expect(parsed.ok && parsed.value.linked).toEqual({ 'https://tenant.sharepoint.com/sites/X/Spec.docx': { paths: ['_linked/2026-07-20/Spec.docx.md'] } });
    expect(parsed.ok && parsed.value.attachments['sha256-abc']?.primary).toBe('_attachments/Deck.pptx.md');
  });

  it('the watermark is the newest post already filed, whatever order the threads were written in', () => {
    const state = withGroupThread(
      withGroupThread(emptyGroupState('0d3b-group', 'MOOV Leadership Team'), 'older', record({ lastMessage: '2026-07-20T10:45:14Z' })),
      'newer',
      record({ lastMessage: '2026-08-10T05:40:15Z' })
    );

    expect(watermarkOf(state)).toBe('2026-08-10T05:40:15Z');
  });

  it('the newest post wins the watermark even when it was filed first, so the comparison is doing the work', () => {
    const state = withGroupThread(
      withGroupThread(emptyGroupState('0d3b-group', 'MOOV Leadership Team'), 'newer', record({ lastMessage: '2026-08-10T05:40:15Z' })),
      'older',
      record({ lastMessage: '2026-07-20T10:45:14Z' })
    );

    expect(watermarkOf(state)).toBe('2026-08-10T05:40:15Z');
  });

  it('a group holding nothing has a watermark older than any post, so the first run sweeps everything', () => {
    expect(watermarkOf(emptyGroupState('0d3b-group', 'MOOV Leadership Team'))).toBe('');
  });
});

describe('remembering a group thread the run could not write', () => {
  const failed = { attempts: 1, reason: 'permanent: thread refused' };
  const empty = (): ReturnType<typeof emptyGroupState> => emptyGroupState('0d3b-group', 'MOOV Leadership Team');

  it('a state file written before failed threads were remembered loads with an empty ledger', () => {
    const parsed = parseGroupState({ version: GROUP_STATE_VERSION, source: { kind: 'group', id: '0d3b-group', name: 'MOOV Leadership Team' } });

    expect(parsed.ok && parsed.value.retry).toEqual({});
  });

  it('what one run remembers about a failed thread, the next run reads back unchanged', () => {
    const state = withGroupRetry(empty(), 'AAQkAD-thread', failed);

    expect(parseGroupState(JSON.parse(serializeGroupState(state)))).toEqual({ ok: true, value: state });
  });

  it('a thread remembered as failed is dropped once it renders', () => {
    expect(withoutGroupRetry(withGroupRetry(empty(), 'AAQkAD-thread', failed), 'AAQkAD-thread').retry).toEqual({});
  });

  it('a thread nothing failed on leaves the ledger untouched', () => {
    const remembered = withGroupRetry(empty(), 'AAQkAD-thread', failed);

    expect(withoutGroupRetry(remembered, 'other')).toEqual(remembered);
  });
});
