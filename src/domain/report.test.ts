import { describe, expect, it } from 'bun:test';
import type { ReportRun } from './report.ts';
import { appendReportRun, hasSomethingToReport, renderReportRun, reportHeading, tooLargeReason, UNSUPPORTED_REASON } from './report.ts';

const run = (over: Partial<ReportRun> = {}): ReportRun => ({
  source: 'Espace Contoso',
  at: '2026-07-24T09:00:00Z',
  counts: '12 converted, 0 moved, 0 archived, 2 skipped, 1 failed.',
  skipped: [],
  failed: [],
  archived: [],
  ...over,
});

describe('telling the operator what did not reach the knowledge base', () => {
  it('a run that left files behind names each one and why', () => {
    const rendered = renderReportRun(
      run({
        skipped: [
          { path: 'Documents/Demo.mp4', reason: UNSUPPORTED_REASON },
          { path: 'Documents/Enorme.pptx', reason: tooLargeReason(50 * 1024 * 1024) },
        ],
        failed: [{ path: 'Documents/Contrat.docx', reason: 'permanent: file is locked' }],
      })
    );

    expect(rendered).toBe(
      [
        '## 2026-07-24T09:00:00Z',
        '',
        '12 converted, 0 moved, 0 archived, 2 skipped, 1 failed.',
        '',
        'Left in place, nothing was written for these:',
        '- Documents/Demo.mp4: a kind of file this tool does not read',
        '- Documents/Enorme.pptx: larger than the 50 MB cap',
        '',
        'Could not be read, and will be tried again on the next run:',
        '- Documents/Contrat.docx: permanent: file is locked',
        '',
      ].join('\n')
    );
  });

  it('files the source no longer has are reported as moved aside', () => {
    const rendered = renderReportRun(run({ archived: [{ path: 'Documents/Ancien.docx', reason: 'deleted at the source' }] }));

    expect(rendered).toContain('No longer at the source, moved aside:');
    expect(rendered).toContain('- Documents/Ancien.docx: deleted at the source');
  });

  it('two files left out for the same reason under the same name are listed once', () => {
    const rendered = renderReportRun(
      run({
        counts: '29 converted, 0 moved, 0 archived, 2 skipped, 0 failed.',
        skipped: [
          { path: 'threads/2026/Kick-off.md: image002.wmz', reason: UNSUPPORTED_REASON },
          { path: 'threads/2026/Kick-off.md: image002.wmz', reason: UNSUPPORTED_REASON },
        ],
      })
    );

    expect(rendered.split('image002.wmz')).toHaveLength(2);
    expect(rendered).toContain('2 skipped');
  });

  it('a heading with nothing under it is left out entirely', () => {
    const rendered = renderReportRun(run({ skipped: [{ path: 'a.mp4', reason: UNSUPPORTED_REASON }] }));

    expect(rendered).not.toContain('Could not be read');
    expect(rendered).not.toContain('No longer at the source');
  });

  it('the size cap is stated in the units the operator set it in', () => {
    expect(tooLargeReason(50 * 1024 * 1024)).toBe('larger than the 50 MB cap');
    expect(tooLargeReason(200 * 1024 * 1024)).toBe('larger than the 200 MB cap');
  });
});

describe('deciding whether a run is worth reporting', () => {
  it('a run that converted everything is not written down', () => {
    expect(hasSomethingToReport(run())).toBe(false);
  });

  it('a run that left anything behind is written down', () => {
    expect(hasSomethingToReport(run({ skipped: [{ path: 'a.mp4', reason: UNSUPPORTED_REASON }] }))).toBe(true);
    expect(hasSomethingToReport(run({ failed: [{ path: 'a.docx', reason: 'locked' }] }))).toBe(true);
    expect(hasSomethingToReport(run({ archived: [{ path: 'a.docx', reason: 'deleted' }] }))).toBe(true);
  });
});

describe('keeping the report across runs', () => {
  it('the first run opens the file with a heading naming the source', () => {
    const written = appendReportRun(undefined, run({ skipped: [{ path: 'a.mp4', reason: UNSUPPORTED_REASON }] }));

    expect(written.startsWith(`${reportHeading('Espace Contoso')}\n`)).toBe(true);
    expect(written).toContain('- a.mp4: a kind of file this tool does not read');
  });

  it('a later run is written above the one before it, so the file opens on what happened last', () => {
    const first = appendReportRun(undefined, run({ at: '2026-07-23T09:00:00Z', skipped: [{ path: 'old.mp4', reason: UNSUPPORTED_REASON }] }));
    const second = appendReportRun(first, run({ at: '2026-07-24T09:00:00Z', skipped: [{ path: 'new.mp4', reason: UNSUPPORTED_REASON }] }));

    expect(second.indexOf('2026-07-24')).toBeLessThan(second.indexOf('2026-07-23'));
    expect(second).toContain('- old.mp4:');
    expect(second).toContain('- new.mp4:');
  });

  it('the heading is written once however many runs the file holds', () => {
    const first = appendReportRun(undefined, run({ skipped: [{ path: 'a.mp4', reason: UNSUPPORTED_REASON }] }));
    const second = appendReportRun(first, run({ at: '2026-07-25T09:00:00Z', failed: [{ path: 'b.docx', reason: 'locked' }] }));

    expect(second.split(reportHeading('Espace Contoso'))).toHaveLength(2);
  });

  it('the file ends with exactly one newline, however many runs it holds', () => {
    const written = appendReportRun(undefined, run({ skipped: [{ path: 'a.mp4', reason: UNSUPPORTED_REASON }] }));

    expect(written.endsWith('\n')).toBe(true);
    expect(written.endsWith('\n\n')).toBe(false);
  });
});
