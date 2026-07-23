import { describe, expect, it } from 'bun:test';
import { annotate, parseSelection } from './picker.ts';

describe('showing what can be synced', () => {
  it('a site already in the knowledge base is marked with when it ran and what it holds', () => {
    const rows = annotate([{ id: 'a', name: 'Espace MOOV', webUrl: 'https://x' }], { a: { lastRun: '2026-07-22T09:00:00Z', fileCount: 143 } });

    expect(rows).toEqual([{ id: 'a', name: 'Espace MOOV', webUrl: 'https://x', synced: { lastRun: '2026-07-22T09:00:00Z', fileCount: 143 } }]);
  });

  it('a site never synced carries no mark', () => {
    expect(annotate([{ id: 'b', name: 'Autre' }], {})).toEqual([{ id: 'b', name: 'Autre', webUrl: '' }]);
  });
});

describe('reading what the operator chose', () => {
  it('one number chooses one source', () => {
    expect(parseSelection('2', 5)).toEqual({ ok: true, value: { kind: 'rows', indices: [1] } });
  });

  it('several numbers choose several libraries at once', () => {
    expect(parseSelection('1, 3', 5)).toEqual({ ok: true, value: { kind: 'rows', indices: [0, 2] } });
  });

  it('asking for all takes every choice on offer', () => {
    expect(parseSelection('all', 3)).toEqual({ ok: true, value: { kind: 'rows', indices: [0, 1, 2] } });
  });

  it('pasting an address reaches a site the list does not show', () => {
    expect(parseSelection('https://tenant.sharepoint.com/sites/X', 3)).toEqual({ ok: true, value: { kind: 'address', url: 'https://tenant.sharepoint.com/sites/X' } });
  });

  it('u refreshes everything already in the knowledge base', () => {
    expect(parseSelection('u', 3)).toEqual({ ok: true, value: { kind: 'update-all' } });
  });

  it('q leaves without touching anything', () => {
    expect(parseSelection('q', 3)).toEqual({ ok: true, value: { kind: 'quit' } });
  });

  it('a number nobody offered is refused', () => {
    expect(parseSelection('9', 3)).toEqual({ ok: false, error: { kind: 'bad-choice', message: 'no such choice: 9' } });
    expect(parseSelection('0', 3).ok).toBe(false);
    expect(parseSelection('1.5', 3).ok).toBe(false);
  });

  it('answering nothing is refused rather than taken as everything', () => {
    expect(parseSelection('   ', 3)).toEqual({ ok: false, error: { kind: 'bad-choice', message: 'nothing chosen' } });
  });

  it('a list holding one bad number is refused whole, so nothing is synced by accident', () => {
    expect(parseSelection('1,9', 3).ok).toBe(false);
  });
});
