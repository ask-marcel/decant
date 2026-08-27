import { describe, expect, it } from 'bun:test';
import { createNoProgress, createNoStatus, createProgressBar, createStatusLine } from './progress-bar.ts';

const capture = (): { readonly bar: ReturnType<typeof createProgressBar>; readonly writes: string[] } => {
  const writes: string[] = [];
  return { bar: createProgressBar((text) => writes.push(text)), writes };
};

// What the terminal actually shows, row by row: the cursor climb precedes the only `\r` in a write,
// so splitting on it drops the climb, and what remains is the rows with their own controls stripped.
const rowsShown = (write: string | undefined): ReadonlyArray<string> =>
  ((write ?? '').split('\r').at(-1) ?? '')
    .replace('\x1b[J', '')
    .split('\n')
    .map((row) => row.replace('\x1b[K', ''));

describe('showing how far a conversion has got', () => {
  it('the count climbs as each item is done, the block rewriting itself where it already stands', () => {
    const { bar, writes } = capture();

    bar.start(3, 'Converting');
    bar.step('Projets/Contrat.docx');
    bar.step('Projets/Budget.xlsx');

    expect(writes.some((text) => text.includes('Converting') && text.includes('1/3') && text.includes('Contrat.docx'))).toBe(true);
    expect(writes.some((text) => text.includes('2/3') && text.includes('Budget.xlsx'))).toBe(true);
    expect(writes.at(0)?.startsWith('\r')).toBe(true);
    expect(writes.at(-1)?.startsWith('\x1b[1A\r')).toBe(true);
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

  it('every running item gets its own row, so a window of several reads as several files rather than one', () => {
    const { bar, writes } = capture();

    bar.start(3, 'Converting');
    bar.begin('A.docx');
    bar.begin('B.docx');
    bar.begin('C.docx');

    const shown = rowsShown(writes.at(-1));
    expect(shown).toHaveLength(4);
    expect(shown.at(0)).toBe('Converting 0/3 (3 running)');
    expect(shown.at(1)).toContain('A.docx');
    expect(shown.at(2)).toContain('B.docx');
    expect(shown.at(3)).toContain('C.docx');
  });

  it('the rows keep the order the items started in, so the straggler holding the window sits at the top', () => {
    const { bar, writes } = capture();

    bar.start(3, 'Converting');
    bar.begin('slow-scan.jpg');
    bar.begin('B.docx');
    bar.begin('C.docx');
    bar.step('B.docx');

    const shown = rowsShown(writes.at(-1));
    expect(shown.at(1)).toContain('slow-scan.jpg');
    expect(shown.at(2)).toContain('C.docx');
  });
});

describe('saying how much is in flight and what each item is doing', () => {
  it('the line says how many are in flight, so a window of eight does not read as one slow file', () => {
    const { bar, writes } = capture();

    bar.start(25, 'Espace Contoso / Documents');
    bar.begin('A.docx');
    bar.begin('B.docx');
    bar.begin('C.docx');

    expect(writes.at(-1)).toContain('0/25 (3 running)');
  });

  it('a lone item says nothing about how many are running, since one is not news', () => {
    const { bar, writes } = capture();

    bar.start(25, 'Espace Contoso / Documents');
    bar.begin('A.docx');

    const shown = rowsShown(writes.at(-1));
    expect(shown.at(0)).toBe('Espace Contoso / Documents 0/25');
    expect(shown.at(1)).toContain('A.docx');
  });

  it('a step reported by the item the line names is shown beside it', () => {
    const { bar, writes } = capture();

    bar.start(2, 'Espace Contoso / Documents');
    bar.begin('A.docx');
    bar.detail('A.docx', 'reading picture 3/6');

    expect(writes.at(-1)).toContain('A.docx \u00b7 reading picture 3/6');
  });

  it('each running item carries its own step on its own row, never drawn against another item name', () => {
    const { bar, writes } = capture();

    bar.start(2, 'Espace Contoso / Documents');
    bar.begin('A.docx');
    bar.begin('B.docx');
    bar.detail('B.docx', 'rendering the slides');

    const shown = rowsShown(writes.at(-1));
    expect(shown.at(1)).toContain('A.docx');
    expect(shown.at(1)).not.toContain('rendering the slides');
    expect(shown.at(2)).toContain('B.docx · rendering the slides');
  });

  it('finishing an item drops its step, so the next name never inherits the last one', () => {
    const { bar, writes } = capture();

    bar.start(2, 'Espace Contoso / Documents');
    bar.begin('A.docx');
    bar.detail('A.docx', 'reading the pages');
    bar.step('A.docx');
    bar.begin('B.docx');

    expect(writes.at(-1)).toContain('B.docx');
    expect(writes.at(-1)).not.toContain('reading the pages');
  });
});

describe('keeping the block inside the rows and columns the cursor can reach', () => {
  it('a redraw climbs back over every row it drew, so the block rewrites itself rather than stacking copies', () => {
    const { bar, writes } = capture();

    bar.start(4, 'Converting');
    bar.begin('A.docx');
    bar.begin('B.docx');
    bar.begin('C.docx');

    // The draw before this one covered a header and two items, so the cursor climbs those three rows
    // before rewriting, and comes back down over four.
    expect(writes.at(-1)?.startsWith('\x1b[2A\r')).toBe(true);
    expect(rowsShown(writes.at(-1))).toHaveLength(4);
  });

  it('a block that shrinks wipes the rows it no longer fills, so a finished item leaves no ghost behind', () => {
    const { bar, writes } = capture();

    bar.start(2, 'Converting');
    bar.begin('A.docx');
    bar.begin('B.docx');
    bar.step('B.docx');

    expect(rowsShown(writes.at(-1))).toHaveLength(2);
    expect(writes.at(-1)).not.toContain('B.docx');
    expect(writes.at(-1)?.endsWith('\x1b[J')).toBe(true);
  });

  it('more running items than the terminal has rows are summarised, so the block never outgrows the screen', () => {
    const writes: string[] = [];
    const bar = createProgressBar(
      (text) => writes.push(text),
      () => 80,
      () => 4
    );

    bar.start(9, 'Converting');
    ['A', 'B', 'C', 'D', 'E'].forEach((name) => bar.begin(`${name}.docx`));

    const shown = rowsShown(writes.at(-1));
    expect(shown).toHaveLength(4);
    expect(shown.at(-1)).toBe('  …and 3 more');
  });

  it('a row too wide for the terminal is cut rather than wrapped onto a row it cannot clear', () => {
    const writes: string[] = [];
    const bar = createProgressBar(
      (text) => writes.push(text),
      () => 40
    );

    bar.start(11, 'MOOV Leadership Team / 文档');
    bar.begin('HELP - Manuals & Guides/IT topics/TMFF/Ocean Export user manual V 2017 8.8.pdf');

    // The control sequences do not occupy a column; what the terminal shows on each row must fit it.
    const shown = rowsShown(writes.at(-1));
    expect(shown.every((row) => [...row].length <= 40)).toBe(true);
    expect(shown.at(0)).toContain('MOOV Leadership Team / 文档');
  });

  it('a row never fills the last column, so the cursor cannot defer a wrap and stack the rows', () => {
    const writes: string[] = [];
    const bar = createProgressBar(
      (text) => writes.push(text),
      () => 40
    );

    bar.start(25, 'SW Project (Lidl instance) / 文档');
    bar.begin('General/04_IT_Security_overview/PT Findings for Lidl.xlsx');

    expect([...(rowsShown(writes.at(-1)).at(1) ?? '')]).toHaveLength(39);
  });

  it('the source survives the cut, since it is the part a path cannot tell you', () => {
    const writes: string[] = [];
    const bar = createProgressBar(
      (text) => writes.push(text),
      () => 32
    );

    bar.start(2, 'Espace Contoso / Documents');
    bar.begin('Projets/2026/Q3/Rapport annuel definitif.docx');

    expect((writes.at(-1) ?? '').replace('\r\x1b[K', '')).toContain('Espace Contoso / Documents');
  });
});

describe('saying what a long listing is doing while it does it', () => {
  it('a status line rewrites itself rather than stacking up, so one line reports the wait', () => {
    const writes: string[] = [];
    const say = createStatusLine((text) => writes.push(text));

    say('Reading the sites you belong to…');
    say('Checking the libraries shared with you…');

    expect(writes).toEqual(['\r\x1b[KReading the sites you belong to…', '\r\x1b[KChecking the libraries shared with you…']);
  });

  it('an empty message clears the line, so the picker prints onto a clean row', () => {
    const writes: string[] = [];
    const say = createStatusLine((text) => writes.push(text));

    say('');

    expect(writes).toEqual(['\r\x1b[K']);
  });
});

describe('a run with no terminal to draw on', () => {
  it('says nothing at all, so a piped or scheduled listing stays clean', () => {
    expect(createNoStatus()('Reading the sites you belong to…')).toBeUndefined();
  });
});
