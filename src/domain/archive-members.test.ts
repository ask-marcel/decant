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
    // A root path names the root of a site, which need not be the root of the archive.
    expect(linkMembers('[Root](/logo.png)', 'index.html', files)).toBe('[Root](/logo.png)');
  });
});
