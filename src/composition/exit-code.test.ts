import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { SourceRun } from '../use-cases/sync-site.ts';
import { exitCodeOf } from './exit-code.ts';

const source = (failed: number): SourceRun => ({
  id: 'site!contoso',
  source: 'Espace Contoso',
  summary: { converted: 4, moved: 0, archived: 0, skipped: 0, failed, queued: 0 },
  notes: { skipped: [], failed: [], givenUp: [], archived: [] },
});

// A script that runs decant (a backup, a commit of the knowledge base) goes on after a run that
// finished, with or without failed items, and stops after one that did not finish.
describe('telling a script how the run ended', () => {
  it('a run that finished exits 0, one that finished with failed items exits 3, and one that stopped exits 1', () => {
    expect(exitCodeOf(ok([source(0), source(0)]))).toBe(0);
    expect(exitCodeOf(ok([]))).toBe(0);
    expect(exitCodeOf(ok([source(0), source(2)]))).toBe(3);
    expect(exitCodeOf(err({ step: 'readSince', cause: 'bad-since', message: 'mistyped' }))).toBe(1);
  });
});
