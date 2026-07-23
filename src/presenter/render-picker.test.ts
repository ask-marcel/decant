import { describe, expect, it } from 'bun:test';
import { renderLibraryPicker, renderSitePicker, renderSummary } from './render-picker.ts';

const rows = [
  { id: 'a', name: 'Espace MOOV', webUrl: 'https://x', synced: { lastRun: '2026-07-22T09:00:00Z', fileCount: 143 } },
  { id: 'b', name: 'Direction', webUrl: 'https://y' },
];

describe('showing the operator what there is to sync', () => {
  it('each site is numbered, and the ones already synced say when and how much', () => {
    const rendered = renderSitePicker(rows);

    expect(rendered).toContain('  1) Espace MOOV  (synced 2026-07-22, 143 files)');
    expect(renderSitePicker([{ id: 'c', name: 'Solo', webUrl: '', synced: { lastRun: '2026-07-22T09:00:00Z', fileCount: 1 } }])).toContain('1 file)');
    expect(rendered).toContain('  2) Direction  (new)');
  });

  it('the ways out of the picker are spelled out', () => {
    expect(renderSitePicker(rows)).toContain('u = refresh everything already synced, q = quit.');
  });

  it('libraries are offered the same way, several at a time', () => {
    expect(renderLibraryPicker([{ id: 'b!one', name: 'Documents', webUrl: '' }])).toContain('Choose one or more numbers (1,3), or all.');
  });
});

describe('telling the operator what happened', () => {
  it('a finished run counts what it did', () => {
    const summary = { converted: 12, moved: 1, archived: 2, skipped: 3, failed: 0, queued: 0 };

    expect(renderSummary('Espace MOOV', summary, false)).toBe('Espace MOOV: 12 converted, 1 moved, 2 archived, 3 skipped, 0 failed.');
  });

  it('a dry run says what it would have done and that it wrote nothing', () => {
    const summary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 47 };

    expect(renderSummary('Espace MOOV', summary, true)).toBe('Espace MOOV: 47 to do (nothing written, this was a dry run).');
  });

  it('a dry run over a library holding nothing still says it wrote nothing', () => {
    const summary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

    expect(renderSummary('Espace MOOV', summary, true)).toBe('Espace MOOV: 0 to do (nothing written, this was a dry run).');
  });
});
