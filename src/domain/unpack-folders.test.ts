import { describe, expect, it } from 'bun:test';
import type { DriveState } from './site-state.ts';
import { unpackDrive } from './unpack-folders.ts';

const drive = (items: DriveState['items']): DriveState => ({ name: 'Documents', pending: [], items, retry: {} });

describe('moving each archive and saved email of a library into the folder named for the whole file', () => {
  // The first layout named the folder for the file less its extension, `Livraison/`, which a library
  // folder of that name could share.
  it('each file of a zip and of a saved email leaves the folder named less its extension for the one named for the whole file', () => {
    const moved = unpackDrive(
      drive({
        '01ZIP': { path: 'Projets/Livraison.zip', cTag: 'c1', outputs: ['kb/S/D/Projets/Livraison/Livraison.zip', 'kb/S/D/Projets/Livraison/Livraison/notes.docx.md'] },
        '01EML': { path: 'Fwd.eml', cTag: 'c1', outputs: ['kb/S/D/Fwd/Fwd.eml.md', 'kb/S/D/Fwd/x.pdf', 'kb/S/D/Fwd/x.pdf.md'] },
      })
    );

    expect(moved.moves).toEqual([
      { from: 'kb/S/D/Projets/Livraison/Livraison.zip', to: 'kb/S/D/Projets/Livraison.zip/Livraison.zip' },
      { from: 'kb/S/D/Projets/Livraison/Livraison/notes.docx.md', to: 'kb/S/D/Projets/Livraison.zip/Livraison/notes.docx.md' },
      { from: 'kb/S/D/Fwd/Fwd.eml.md', to: 'kb/S/D/Fwd.eml/Fwd.eml.md' },
      { from: 'kb/S/D/Fwd/x.pdf', to: 'kb/S/D/Fwd.eml/x.pdf' },
      { from: 'kb/S/D/Fwd/x.pdf.md', to: 'kb/S/D/Fwd.eml/x.pdf.md' },
    ]);
    expect(moved.drive.items['01ZIP']?.outputs).toEqual(['kb/S/D/Projets/Livraison.zip/Livraison.zip', 'kb/S/D/Projets/Livraison.zip/Livraison/notes.docx.md']);
    expect(moved.drive.items['01EML']?.outputs).toEqual(['kb/S/D/Fwd.eml/Fwd.eml.md', 'kb/S/D/Fwd.eml/x.pdf', 'kb/S/D/Fwd.eml/x.pdf.md']);
  });

  // The folder is read off the file the conversion wrote first, so a name decant made safe or cut to fit a
  // path keeps what was done to it.
  it('a zip whose name decant made safe moves into the folder named for the name it was written under', () => {
    const moved = unpackDrive(drive({ '01ZIP': { path: 'Plans: Q3.zip', cTag: 'c1', outputs: ['kb/S/D/Plans_ Q3/Plans_ Q3.zip', 'kb/S/D/Plans_ Q3/notes.docx.md'] } }));

    expect(moved.drive.items['01ZIP']?.outputs).toEqual(['kb/S/D/Plans_ Q3.zip/Plans_ Q3.zip', 'kb/S/D/Plans_ Q3.zip/notes.docx.md']);
  });

  it('a document of another kind, an archive already in its folder and one with no file stay where they are', () => {
    const items = {
      '01DOC': { path: 'Livraison/notes.docx', cTag: 'c1', outputs: ['kb/S/D/Livraison/notes.docx.md'] },
      '01NEW': { path: 'Livraison.zip', cTag: 'c1', outputs: ['kb/S/D/Livraison.zip/Livraison.zip', 'kb/S/D/Livraison.zip/notes.docx.md'] },
      '01NONE': { path: 'Empty.zip', cTag: 'c1', outputs: [] },
    };
    const moved = unpackDrive(drive(items));

    expect(moved.moves).toStrictEqual([]);
    expect(moved.drive.items).toEqual(items);
  });

  // The first layout let a library folder named for an archive and the archive unpacked into it write
  // one file. Both records hold it, and a move would leave the other one naming a file that is gone.
  it('a file that two records hold stays where it is, and the files only the archive holds move', () => {
    const moved = unpackDrive(
      drive({
        '01DOC': { path: 'Livraison/notes.docx', cTag: 'c1', outputs: ['kb/S/D/Livraison/notes.docx.md'] },
        '01ZIP': { path: 'Livraison.zip', cTag: 'c1', outputs: ['kb/S/D/Livraison/Livraison.zip', 'kb/S/D/Livraison/notes.docx.md'] },
      })
    );

    expect(moved.moves).toEqual([{ from: 'kb/S/D/Livraison/Livraison.zip', to: 'kb/S/D/Livraison.zip/Livraison.zip' }]);
    expect(moved.drive.items['01ZIP']?.outputs).toEqual(['kb/S/D/Livraison.zip/Livraison.zip', 'kb/S/D/Livraison/notes.docx.md']);
    expect(moved.drive.items['01DOC']?.outputs).toEqual(['kb/S/D/Livraison/notes.docx.md']);
  });

  // A move that failed left some files of an archive in each folder, and the next run moves the rest.
  it('an archive half moved by an earlier run moves the files still in the folder named less its extension', () => {
    const moved = unpackDrive(drive({ '01ZIP': { path: 'Livraison.zip', cTag: 'c1', outputs: ['kb/S/D/Livraison.zip/Livraison.zip', 'kb/S/D/Livraison/notes.docx.md'] } }));

    expect(moved.moves).toEqual([{ from: 'kb/S/D/Livraison/notes.docx.md', to: 'kb/S/D/Livraison.zip/notes.docx.md' }]);
  });
});
