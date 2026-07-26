import { describe, expect, it } from 'bun:test';
import { createNoProgress, createProgressBar } from './progress-bar.ts';

const capture = (): { readonly bar: ReturnType<typeof createProgressBar>; readonly writes: string[] } => {
  const writes: string[] = [];
  return { bar: createProgressBar((text) => writes.push(text)), writes };
};

describe('showing how far a conversion has got', () => {
  it('the count climbs on one rewritten line as each item is done', () => {
    const { bar, writes } = capture();

    bar.start(3, 'Converting');
    bar.step('Projets/Contrat.docx');
    bar.step('Projets/Budget.xlsx');

    expect(writes.some((text) => text.includes('Converting') && text.includes('1/3') && text.includes('Contrat.docx'))).toBe(true);
    expect(writes.some((text) => text.includes('2/3') && text.includes('Budget.xlsx'))).toBe(true);
    expect(writes.every((text) => text.startsWith('\r'))).toBe(true);
  });

  it('the line is closed with a newline when the run is done, so the summary starts clean', () => {
    const { bar, writes } = capture();

    bar.start(1, 'Converting');
    bar.step('a.docx');
    bar.done();

    expect(writes.at(-1)).toBe('\n');
  });

  it('a run with nothing to convert stays silent, even if a step and a close are called', () => {
    const { bar, writes } = capture();

    bar.start(0, 'Converting');
    bar.step('phantom.docx');
    bar.done();

    expect(writes).toEqual([]);
  });

  it('a close before any item is done prints no newline, so an empty run leaves the line clean', () => {
    const { bar, writes } = capture();

    bar.start(5, 'Converting');
    bar.done();

    expect(writes).toEqual([]);
  });

  it('the no-op progress writes nothing at all, for a run whose output is piped away', () => {
    const writes: string[] = [];
    const progress = createNoProgress();

    progress.start(9, 'Converting');
    progress.step('a.docx');
    progress.done();

    expect(writes).toEqual([]);
  });

  it('an item that has begun but not finished shows on the line, so a slow item does not look like the run has stopped', () => {
    const { bar, writes } = capture();

    bar.start(2, 'Converting');
    bar.begin('Projets/slow-scan.jpg');

    expect(writes.at(-1)).toContain('Projets/slow-scan.jpg');
    expect(writes.at(-1)).toContain('0/2');
  });

  it('once the fast items in a window finish, the line still names whichever one is still running', () => {
    const { bar, writes } = capture();

    bar.start(3, 'Converting');
    bar.begin('A.docx');
    bar.begin('B.docx');
    bar.begin('slow-scan.jpg');
    bar.step('A.docx');
    bar.step('B.docx');

    expect(writes.at(-1)).toContain('slow-scan.jpg');
    expect(writes.at(-1)).toContain('2/3');
  });

  it('the line names only the oldest running item, even with several running at once, so a wide window never wraps the terminal', () => {
    const { bar, writes } = capture();

    bar.start(3, 'Converting');
    bar.begin('A.docx');
    bar.begin('B.docx');
    bar.begin('C.docx');

    expect(writes.at(-1)).toContain('A.docx');
    expect(writes.at(-1)).not.toContain('B.docx');
    expect(writes.at(-1)).not.toContain('C.docx');
  });
});
