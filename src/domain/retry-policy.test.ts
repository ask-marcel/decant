import { describe, expect, it } from 'bun:test';
import type { DriveItem } from './drive-item.ts';
import type { RetryEntry } from './retry-policy.ts';
import { forgetSwept, nextFailure } from './retry-policy.ts';

const file = (over: Partial<DriveItem> = {}): DriveItem => ({
  id: '01ABC',
  name: 'Roadmap.pptx',
  kind: 'file',
  size: 4096,
  path: 'Projets/Roadmap.pptx',
  lastModified: '2026-05-12T09:31:00Z',
  cTag: 'c1',
  webUrl: 'https://tenant.sharepoint.com/Roadmap.pptx',
  ...over,
});

const failed = (over: Partial<DriveItem> = {}, attempts = 1): RetryEntry => ({ item: file(over), attempts, reason: 'transient: gateway timeout' });

describe('counting what a document has cost so far', () => {
  it('a second failure of the same version counts as a second try', () => {
    expect(nextFailure(failed(), file(), 'transient: gateway timeout')).toEqual({ item: file(), attempts: 2, reason: 'transient: gateway timeout' });
  });

  it('a failure of a version edited since starts the count again', () => {
    expect(nextFailure(failed({}, 2), file({ cTag: 'c2' }), 'permanent: locked').attempts).toBe(1);
  });

  it('a file failing for the first time is on its first try', () => {
    expect(nextFailure(undefined, file(), 'permanent: locked').attempts).toBe(1);
  });
});

describe('what the sweep settles for itself', () => {
  it('an item the sweep returned is dropped from the ledger, whatever it decided about it', () => {
    expect(forgetSwept({ '01ABC': failed() }, [file({ kind: 'deleted' })])).toEqual({});
  });

  it('an item the sweep said nothing about stays in the ledger', () => {
    const ledger = { '01ABC': failed() };

    expect(forgetSwept(ledger, [file({ id: 'other', path: 'other.docx' })])).toEqual(ledger);
  });
});
