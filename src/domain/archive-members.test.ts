import { describe, expect, it } from 'bun:test';
import { linkMembers, placeMembers } from './archive-members.ts';

const FOLDER = 'kb/Docs/Report';

const placed = (archiveName: string, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  placeMembers(
    FOLDER,
    archiveName,
    paths.map((path) => ({ path })),
    undefined
  ).map((member) => member.file);

describe('where the members of an archive are unpacked', () => {
  // Zipping a folder puts every member in one folder named for it, which beside the archive only
  // repeats its name.
  it('drops the folder every member sits in when it is named for the archive', () => {
    expect(placed('Weekly report.zip', ['Weekly report/index.html', 'Weekly report/pages/week2.html'])).toStrictEqual([`${FOLDER}/index.html.md`, `${FOLDER}/pages/week2.html.md`]);
    expect(placed('weekly-report.zip', ['Weekly-Report/index.html'])).toStrictEqual([`${FOLDER}/index.html.md`]);
  });

  it('keeps the folders of members that do not all sit in one folder named for the archive', () => {
    expect(placed('Report.zip', ['Report/index.html', 'notes.docx'])).toStrictEqual([`${FOLDER}/Report/index.html.md`, `${FOLDER}/notes.docx.md`]);
    expect(placed('Report.zip', ['Draft/index.html'])).toStrictEqual([`${FOLDER}/Draft/index.html.md`]);
    expect(placed('Report.zip', ['Report'])).toStrictEqual([`${FOLDER}/Report.md`]);
    expect(placed('Report.zip', ['Reports/index.html'])).toStrictEqual([`${FOLDER}/Reports/index.html.md`]);
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
  });
});
