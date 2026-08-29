import { describe, expect, it } from 'bun:test';
import { renderZipManifest } from './zip-manifest.ts';

describe('listing what an archive holds', () => {
  // Pinned whole: the manifest IS the document a reader opens instead of unzipping, so where its
  // lines fall is the thing being built.
  it('a manifest names every member and what was read out of it', () => {
    const members = [
      { path: '01-entrance.jpg', text: 'FEN-SH-JA entrance' },
      { path: 'survey/notes.docx', text: 'Rack elevation, Jing an backroom.' },
    ];

    expect(renderZipManifest('store-photos.zip', members)).toBe(
      ['# store-photos.zip', '', '2 files.', '', '- 01-entrance.jpg — FEN-SH-JA entrance', '- survey/notes.docx — Rack elevation, Jing an backroom.', ''].join('\n')
    );
  });

  // The point of the manifest for a folder of photographs: the text sits in one place with context
  // around it, rather than scattered across forty files a reader has to open one at a time.
  // Pinned whole rather than by fragment: a member with nothing to say must list as its name alone,
  // and `toContain` cannot tell that from a name followed by an empty dash.
  it('a member nothing could be read from is still listed, so the archive reads as complete', () => {
    const written = renderZipManifest('store-photos.zip', [{ path: '02-blank.jpg' }, { path: '03-locked.pdf', note: 'password protected' }]);

    expect(written).toBe(['# store-photos.zip', '', '2 files.', '', '- 02-blank.jpg', '- 03-locked.pdf — password protected', ''].join('\n'));
  });

  it('padding around what was read is dropped, so every entry starts on its words', () => {
    expect(renderZipManifest('a.zip', [{ path: 'note.txt', text: '   spaced out   ' }])).toContain('- note.txt — spaced out\n');
  });

  it('a member whose text runs long is cut to a line, since the file itself holds the rest', () => {
    const written = renderZipManifest('a.zip', [{ path: 'long.txt', text: 'x'.repeat(400) }]);

    expect(written.split('\n').every((line) => line.length < 200)).toBe(true);
    expect(written).toContain('…');
  });

  it('text spread over several lines is folded onto one, so a member is one entry', () => {
    expect(renderZipManifest('a.zip', [{ path: 'note.txt', text: 'first\n\nsecond' }])).toContain('- note.txt — first second');
  });

  it('an archive holding nothing says so rather than trailing off', () => {
    expect(renderZipManifest('empty.zip', [])).toBe(['# empty.zip', '', 'No files.', ''].join('\n'));
  });
});
