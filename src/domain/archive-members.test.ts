import { describe, expect, it } from 'bun:test';
import { linkMembers, placeMembers } from './archive-members.ts';

const FOLDER = 'kb/Docs/Report';

describe('where the members of an archive are unpacked', () => {
  // A zip made of a folder holds every member in that folder, and a library often holds the folder
  // itself beside the zip: without the folder, each member would land on the file of the same name.
  it('each member lands under its own folders, also the one that every member shares', () => {
    const placed = placeMembers(FOLDER, [{ path: 'Report/index.html' }, { path: 'Report/pages/week2.html' }], undefined);

    expect(placed.map((member) => member.file)).toStrictEqual([`${FOLDER}/Report/index.html.md`, `${FOLDER}/Report/pages/week2.html.md`]);
  });
});

describe('where the members of a zip in a library are unpacked', () => {
  // The name the source gave the archive comes with a zip in a library, which unpacks into a folder
  // named for the whole file.
  const unpacked = (paths: ReadonlyArray<string>, archiveName: string): ReadonlyArray<string> =>
    placeMembers(
      FOLDER,
      paths.map((path) => ({ path })),
      undefined,
      archiveName
    ).map((member) => member.file);

  // Windows zips a folder that way, and unpacked into `Report.zip/`, the folder only repeats the name.
  it('drops the folder every member sits in when it is named for the archive, letter case and accents written either way', () => {
    expect(unpacked(['Weekly report/index.html', 'Weekly report/pages/week2.html'], 'Weekly report.zip')).toStrictEqual([
      `${FOLDER}/index.html.md`,
      `${FOLDER}/pages/week2.html.md`,
    ]);
    expect(unpacked(['Weekly-Report/index.html'], 'weekly-report.zip')).toStrictEqual([`${FOLDER}/index.html.md`]);
    expect(unpacked(['Caf\u00e9/menu.html'], 'Cafe\u0301.zip')).toStrictEqual([`${FOLDER}/menu.html.md`]);
  });

  // A Mac adds the resource forks of the zipped folder beside it, in a folder of their own.
  it('drops the shared folder beside the resource forks a Mac adds, which keep their own folder', () => {
    expect(unpacked(['Report/index.html', '__MACOSX/Report/._index.html'], 'Report.zip')).toStrictEqual([`${FOLDER}/index.html.md`, `${FOLDER}/__MACOSX/Report/._index.html.md`]);
  });

  it('keeps the folders of members that do not all sit in one folder named for the archive', () => {
    expect(unpacked(['Report/index.html', 'notes.docx'], 'Report.zip')).toStrictEqual([`${FOLDER}/Report/index.html.md`, `${FOLDER}/notes.docx.md`]);
    expect(unpacked(['Draft/index.html'], 'Report.zip')).toStrictEqual([`${FOLDER}/Draft/index.html.md`]);
    expect(unpacked(['Reports/index.html'], 'Report.zip')).toStrictEqual([`${FOLDER}/Reports/index.html.md`]);
    expect(unpacked(['Report'], 'Report.zip')).toStrictEqual([`${FOLDER}/Report.md`]);
    expect(unpacked(['Reports', 'Report/index.html'], 'Report.zip')).toStrictEqual([`${FOLDER}/Reports.md`, `${FOLDER}/Report/index.html.md`]);
    expect(unpacked(['__MACOSX/Report/._index.html'], 'Report.zip')).toStrictEqual([`${FOLDER}/__MACOSX/Report/._index.html.md`]);
  });

  // Two folders that differ in letter case are two folders in the archive, and would be one on disk.
  it('keeps two folders whose names differ only in letter case', () => {
    expect(unpacked(['Report/a.html', 'REPORT/a.html'], 'Report.zip')).toStrictEqual([`${FOLDER}/Report/a.html.md`, `${FOLDER}/REPORT/a.html.md`]);
  });
});

describe('a link from one member of an archive to another', () => {
  const files = new Map([
    ['index.html', `${FOLDER}/index.html.md`],
    ['pages/week 2.html', `${FOLDER}/pages/week 2.html.md`],
    ['logo.png', `${FOLDER}/logo.png.md`],
  ]);

  // A page links to the pages beside it by their own names, and on disk each became its markdown.
  it('leads to the markdown written for that member, with its anchor', () => {
    expect(linkMembers('See [Week 2](pages/week%202.html#totals).', 'index.html', files)).toBe('See [Week 2](<pages/week 2.html.md#totals>).');
    expect(linkMembers('[Home](../index.html)', 'pages/week 2.html', files)).toBe('[Home](../index.html.md)');
    expect(linkMembers('[Home](<../index.html>)', 'pages/week 2.html', files)).toBe('[Home](../index.html.md)');
  });

  // The converter writes a title after the destination, escapes each parenthesis of a destination and
  // each bracket of a label, and puts a linked picture in the label.
  it('a link in each form the converter writes leads to the markdown of that member', () => {
    const named = new Map([...files, ['Rapport (2).html', `${FOLDER}/Rapport (2).html.md`]]);

    expect(linkMembers('[Week 2](pages/week%202.html "Week 2")', 'index.html', named)).toBe('[Week 2](<pages/week 2.html.md> "Week 2")');
    expect(linkMembers('[Week 2](pages/week%202.html\n  "Week 2")', 'index.html', named)).toBe('[Week 2](<pages/week 2.html.md>\n  "Week 2")');
    expect(linkMembers('[Report](Rapport%20\\(2\\).html)', 'index.html', named)).toBe('[Report](<Rapport (2).html.md>)');
    expect(linkMembers('[Report](<Rapport \\(2\\).html>)', 'index.html', named)).toBe('[Report](<Rapport (2).html.md>)');
    expect(linkMembers('[![Logo](logo.png)](pages/week%202.html)', 'index.html', named)).toBe('[![Logo](logo.png)](<pages/week 2.html.md>)');
    expect(linkMembers('[![Logo](logo.png) Home!](../index.html)', 'pages/week 2.html', named)).toBe('[![Logo](logo.png) Home!](../index.html.md)');
    expect(linkMembers('[\\[Home\\]](../index.html)', 'pages/week 2.html', named)).toBe('[\\[Home\\]](../index.html.md)');
  });

  // The converter escapes each bracket of a log line, `\\[INFO\\]`. A link that started at one read on
  // to the end of the page from each of them, and a page of some thousands took seconds.
  it('a link starts at no escaped bracket, so a page of escaped brackets reads in linear time', () => {
    const page = `${'\\[INFO\\] job done\n'.repeat(5000)}[Home](../index.html)`;
    const started = performance.now();

    expect(linkMembers(page, 'pages/week 2.html', files)).toEndWith('[Home](../index.html.md)');
    expect(performance.now() - started).toBeLessThan(500);
    expect(linkMembers('![\\[Logo\\]](logo.png)', 'index.html', files)).toBe('![\\[Logo\\]](logo.png)');
  });

  // A title can hold text that reads as a link, and it stays part of the title.
  it('a link in the title of a link is left as it is, with the link around it', () => {
    expect(linkMembers('[Home](../index.html "see [Week 2](week%202.html)")', 'pages/week 2.html', files)).toBe('[Home](../index.html.md "see [Week 2](week%202.html)")');
  });

  // The converter escapes a quote inside a title, `\\"`.
  it('a link whose title holds an escaped quote leads to the markdown of that member', () => {
    expect(linkMembers('[Home](../index.html "The \\"best\\" [Week 2](week%202.html)")', 'pages/week 2.html', files)).toBe(
      '[Home](../index.html.md "The \\"best\\" [Week 2](week%202.html)")'
    );
  });

  it('text that opens a link and holds no destination stays as it is', () => {
    expect(linkMembers('[Home](../index.html then [Week 2](<week 2.html>)', 'pages/week 2.html', files)).toBe('[Home](../index.html then [Week 2](<week 2.html.md>)');
  });

  // A file on disk takes no query: `index.html.md?tab=2` opens nothing.
  it('a link leaves its query behind and keeps its anchor', () => {
    expect(linkMembers('[Home](../index.html?tab=2#top)', 'pages/week 2.html', files)).toBe('[Home](../index.html.md#top)');
  });

  // `%.h` is no escape, and a browser reads such a link as it is written.
  it('a link whose escapes do not decode leads to the member named as the link is written', () => {
    const named = new Map([...files, ['100%.html', `${FOLDER}/100%.html.md`]]);

    expect(linkMembers('[Full](100%.html)', 'index.html', named)).toBe('[Full](100%.html.md)');
  });

  it('keeps any other link as it was: another site, an anchor, a missing member, a picture, a path out of the archive', () => {
    const text = [
      '[Site](https://contoso.example/index.html)',
      '[Mail](mailto:jane@contoso.example)',
      '[Top](#top)',
      '[Root](/index.html)',
      '[Gone](missing.html)',
      '![Logo](logo.png)',
      '[Out](../../index.html)',
      '[Broken](week%E0%A4%A.html)',
    ].join('\n');

    expect(linkMembers(text, 'pages/week 2.html', files)).toBe(text);
    expect(linkMembers('[Home](index.html)', 'unknown.html', files)).toBe('[Home](index.html)');
    // A root path names the root of a site, which need not be the root of the archive.
    expect(linkMembers('[Root](/logo.png)', 'index.html', files)).toBe('[Root](/logo.png)');
    // Dot segments after a host would take away the scheme and the host of a path.
    expect(linkMembers('[Site](https://contoso.example/../../index.html)', 'index.html', files)).toBe('[Site](https://contoso.example/../../index.html)');
    // Only the start of a destination names a scheme: a member name can hold a colon.
    expect(linkMembers('[Notes](pages/notes:2026.html)', 'index.html', new Map([...files, ['pages/notes:2026.html', `${FOLDER}/pages/notes:2026.html.md`]]))).toBe(
      '[Notes](pages/notes:2026.html.md)'
    );
  });
});
