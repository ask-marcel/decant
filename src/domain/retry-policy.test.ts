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

  it('a failure of a version edited since starts the count again when Graph sends no cTag', () => {
    expect(nextFailure(failed({ cTag: '' }, 2), file({ cTag: '', lastModified: '2026-05-13T10:00:00Z' }), 'permanent: locked').attempts).toBe(1);
    expect(nextFailure(failed({ cTag: '' }, 2), file({ cTag: '' }), 'permanent: locked').attempts).toBe(3);
  });

  it('a file failing for the first time is on its first try', () => {
    expect(nextFailure(undefined, file(), 'permanent: locked').attempts).toBe(1);
  });
});

describe('what the sweep settles for itself', () => {
  it('an item the sweep returned changed or deleted is dropped from the ledger', () => {
    expect(forgetSwept({ '01ABC': failed() }, [file({ kind: 'deleted' })])).toEqual({});
  });

  // A whole read lists every document, changed or not. One that landed without a part of it, and one
  // that failed, are still owed what the entry stands for, and the count of their tries goes on.
  it('an item the sweep returned at the version that failed keeps its entry', () => {
    expect(forgetSwept({ '01ABC': failed() }, [file()])).toEqual({ '01ABC': failed() });
  });

  it('an item the sweep returned edited, or at another path, is dropped from the ledger', () => {
    expect(forgetSwept({ '01ABC': failed() }, [file({ cTag: 'c2' })])).toEqual({});
    expect(forgetSwept({ '01ABC': failed() }, [file({ path: 'Archive/Roadmap.pptx' })])).toEqual({});
  });

  it('an item the sweep returned edited is dropped from the ledger when Graph sends no cTag, by the day and time it changed', () => {
    expect(forgetSwept({ '01ABC': failed({ cTag: '' }) }, [file({ cTag: '', lastModified: '2026-05-13T10:00:00Z' })])).toEqual({});
    expect(forgetSwept({ '01ABC': failed({ cTag: '' }) }, [file({ cTag: '' })])).toEqual({ '01ABC': failed({ cTag: '' }) });
  });

  it('an item the sweep said nothing about stays in the ledger', () => {
    const ledger = { '01ABC': failed() };

    expect(forgetSwept(ledger, [file({ id: 'other', path: 'other.docx' })])).toEqual(ledger);
  });
});
