import { describe, expect, it } from 'bun:test';
import type { DriveDeltaPage } from '../domain/drive-item.ts';
import type { DriveItem } from '../domain/drive-item.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import { sweepDrive } from './enumerate-drive.ts';

const item = (id: string): DriveItem => ({
  id,
  name: `${id}.docx`,
  kind: 'file',
  size: 10,
  path: `${id}.docx`,
  lastModified: '2026-05-12T09:31:00Z',
  cTag: 'c1',
  webUrl: `https://tenant.sharepoint.com/${id}.docx`,
});

const page = (over: Partial<DriveDeltaPage> = {}): DriveDeltaPage => ({ items: [], skipped: 0, ...over });

describe('sweeping a library for what changed', () => {
  it('a library never swept is read from its root', async () => {
    const reader = createDriveReaderFake({ rootItemId: '01ROOT', pages: [page({ items: [item('a')], deltaLink: 'cursor-1' })] });

    const swept = await sweepDrive(reader, 'b!one', undefined);

    expect(swept).toEqual({ ok: true, value: { items: [item('a')], deltaLink: 'cursor-1', skipped: 0 } });
    expect(reader.calls).toEqual(['delta']);
  });

  it('a library swept before starts from the cursor the last run stored', async () => {
    const reader = createDriveReaderFake({ pages: [page({ items: [item('a')], deltaLink: 'cursor-2' })] });

    await sweepDrive(reader, 'b!one', 'cursor-1');

    expect(reader.calls).toEqual(['deltaFrom:cursor-1']);
  });

  it('a change set spanning pages is read to the end, and the last cursor is the one kept', async () => {
    const pages = [page({ items: [item('a')], nextLink: 'page-2' }), page({ items: [item('b')], nextLink: 'page-3' }), page({ items: [item('c')], deltaLink: 'cursor-final' })];
    const reader = createDriveReaderFake({ pages });

    const swept = await sweepDrive(reader, 'b!one', 'cursor-1');

    expect(swept.ok && swept.value.items.map((found) => found.id)).toEqual(['a', 'b', 'c']);
    expect(swept.ok && swept.value.deltaLink).toBe('cursor-final');
    expect(reader.calls).toEqual(['deltaFrom:cursor-1', 'deltaFrom:page-2', 'deltaFrom:page-3']);
  });

  it('items Graph returned unusable are counted across every page, not just the first', async () => {
    const reader = createDriveReaderFake({ pages: [page({ skipped: 2, nextLink: 'page-2' }), page({ skipped: 3, deltaLink: 'cursor-final' })] });

    const swept = await sweepDrive(reader, 'b!one', 'cursor-1');

    expect(swept.ok && swept.value.skipped).toBe(5);
  });

  it('a cursor that leads back to itself ends the sweep rather than looping forever', async () => {
    const reader = createDriveReaderFake({ pages: [page({ items: [item('a')], nextLink: 'same-page' }), page({ items: [item('b')], nextLink: 'same-page' })] });

    const swept = await sweepDrive(reader, 'b!one', 'cursor-1');

    expect(swept.ok && swept.value.items.map((found) => found.id)).toEqual(['a', 'b']);
  });

  it('a library whose root cannot be read ends the sweep with that reason', async () => {
    const reader = createDriveReaderFake({ failWith: { kind: 'permanent', status: 403, message: 'no access' } });

    expect(await sweepDrive(reader, 'b!one', undefined)).toEqual({ ok: false, error: { kind: 'permanent', status: 403, message: 'no access' } });
  });

  it('a page that fails halfway ends the sweep, so no cursor is stored past the gap', async () => {
    const reader = createDriveReaderFake({ pages: [page({ items: [item('a')], nextLink: 'page-2' })], failFrom: { kind: 'transient', message: 'gateway timeout' } });

    expect(await sweepDrive(reader, 'b!one', 'cursor-1')).toEqual({ ok: false, error: { kind: 'transient', message: 'gateway timeout' } });
  });
});
