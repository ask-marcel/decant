import { describe, expect, it } from 'bun:test';
import { datedRoot, outputPrefix, recordedPrefix, refiledOutputs, remapOutputs, undatedOutput } from './output-paths.ts';

describe('naming the files a document produces', () => {
  it('a document in a folder produces files under that folder, named after it', () => {
    expect(outputPrefix('kb/Site/Documents', 'Projets/Roadmap.pptx')).toBe('kb/Site/Documents/Projets/Roadmap.pptx');
  });

  it('a document at the top of the library produces files directly in the library folder', () => {
    expect(outputPrefix('kb/Site/Documents', 'Roadmap.pptx')).toBe('kb/Site/Documents/Roadmap.pptx');
  });

  it('folders and names the filesystem cannot hold are made safe first', () => {
    expect(outputPrefix('kb/Site/Documents', 'Projets: 2026/Q1/Q2.docx')).toBe('kb/Site/Documents/Projets_ 2026/Q1/Q2.docx');
  });
});

describe('following a document that was renamed in SharePoint', () => {
  it('the files it produced follow it, keeping what each one is', () => {
    const outputs = ['kb/S/D/Old.pptx.md', 'kb/S/D/Old.pptx.pdf'];

    expect(remapOutputs(outputs, 'kb/S/D/Old.pptx', 'kb/S/D/Projets/New.pptx')).toEqual(['kb/S/D/Projets/New.pptx.md', 'kb/S/D/Projets/New.pptx.pdf']);
  });

  it('a file recorded somewhere unexpected is left where it is rather than moved wrongly', () => {
    expect(remapOutputs(['kb/elsewhere/x.md'], 'kb/S/D/Old.pptx', 'kb/S/D/New.pptx')).toEqual(['kb/elsewhere/x.md']);
  });
});

describe('filing a document under the day it last changed', () => {
  it('a document is filed under the day it changed, not the day it was synced', () => {
    expect(datedRoot('kb/Site/Documents', '2026-05-12T09:31:00Z')).toBe('kb/Site/Documents/2026-05-12');
  });

  it('a document whose source gave no date is filed under a named folder, not an empty one', () => {
    expect(datedRoot('kb/Site/Documents', '')).toBe('kb/Site/Documents/undated');
  });

  it('a date-like string that does not start the value is not mistaken for the day it changed', () => {
    expect(datedRoot('kb/Site/Documents', 'modified 2026-05-12')).toBe('kb/Site/Documents/undated');
  });

  it('a half-written date is treated as no date rather than filed under part of one', () => {
    expect(datedRoot('kb/Site/Documents', '2026-05-1')).toBe('kb/Site/Documents/undated');
  });

  it('a file whose name is nowhere in its recorded path is left exactly as recorded', () => {
    expect(recordedPrefix('kb/Site/Documents/2026-05-12/other.md', 'Contrat.docx')).toBe('kb/Site/Documents/2026-05-12/other.md');
  });

  it('a recorded path that opens with the name still gives the name back on its own', () => {
    expect(recordedPrefix('Contrat.docx.md', 'Contrat.docx')).toBe('Contrat.docx');
  });

  it("a document's own folders sit under the day, so two of the same name stay apart", () => {
    const day = datedRoot('kb/Site/Documents', '2026-05-12T09:31:00Z');

    expect(outputPrefix(day, 'A/report.docx')).toBe('kb/Site/Documents/2026-05-12/A/report.docx');
    expect(outputPrefix(day, 'B/report.docx')).toBe('kb/Site/Documents/2026-05-12/B/report.docx');
  });
});

describe('filing a document by the folders it has in SharePoint alone', () => {
  // An earlier layout filed each document under the day it last changed. Moved out of that day, the
  // document and every file beside it keep their place under the library and their suffixes.
  it('the files of a document filed under a day move to its folders in the library, each keeping what it is', () => {
    const outputs = ['kb/S/D/2026-05-12/Projets/Contrat.docx.md', 'kb/S/D/2026-05-12/Projets/Contrat.docx.media/image-01.png'];

    expect(refiledOutputs('kb/S/D', 'Projets/Contrat.docx', 'Projets/Contrat.docx', outputs)).toEqual([
      'kb/S/D/Projets/Contrat.docx.md',
      'kb/S/D/Projets/Contrat.docx.media/image-01.png',
    ]);
    expect(refiledOutputs('kb/S/D', 'Projets/Contrat.docx', 'Projets/Contrat.docx', ['kb/S/D/Projets/Contrat.docx.md'])).toEqual(['kb/S/D/Projets/Contrat.docx.md']);
  });

  it('a document renamed or moved in SharePoint takes its files to its new name and folders', () => {
    expect(refiledOutputs('kb/S/D', 'Projets/Contrat.docx', 'Archive/Contrat signe.docx', ['kb/S/D/Projets/Contrat.docx.md', 'kb/S/D/Projets/Contrat.docx.pdf'])).toEqual([
      'kb/S/D/Archive/Contrat signe.docx.md',
      'kb/S/D/Archive/Contrat signe.docx.pdf',
    ]);
    expect(refiledOutputs('kb/S/D', 'a.docx', 'b.docx', [])).toHaveLength(0);
  });
});

// The first layout put every file of a document under the day it last changed. Only that day goes: a
// name cut to fit a Windows path, the pictures of a note and the members of an archive keep theirs.
describe('taking a document out of the day folder the first layout filed it under', () => {
  it('a note under a cut name and its pictures go back under the folders of the document, names unchanged', () => {
    const item = 'Projets/Contrat de service avec le fournisseur.docx';

    expect(undatedOutput('kb/S/D', item, 'kb/S/D/2026-05-12/Projets/Contrat de servi-4db6e62d.docx.md')).toBe('kb/S/D/Projets/Contrat de servi-4db6e62d.docx.md');
    expect(undatedOutput('kb/S/D', item, 'kb/S/D/2026-05-12/Projets/Contrat de servi-4db6e62d.docx.media/image-01.png')).toBe(
      'kb/S/D/Projets/Contrat de servi-4db6e62d.docx.media/image-01.png'
    );
  });

  it('the members of an archive and the parts of a saved mail keep the folder they were unpacked in', () => {
    expect(undatedOutput('kb/S/D', 'Projets/pack.zip', 'kb/S/D/2026-05-12/Projets/pack/pack.zip')).toBe('kb/S/D/Projets/pack/pack.zip');
    expect(undatedOutput('kb/S/D', 'Projets/pack.zip', 'kb/S/D/2026-05-12/Projets/pack/notes/readme.txt.md')).toBe('kb/S/D/Projets/pack/notes/readme.txt.md');
    expect(undatedOutput('kb/S/D', 'Mail.eml', 'kb/S/D/undated/Mail/budget.pdf')).toBe('kb/S/D/Mail/budget.pdf');
  });

  // A SharePoint folder can be named like a day, and a file already moved there is not moved again.
  it('a file already in place stays, though its SharePoint folder is named like a day', () => {
    expect(undatedOutput('kb/S/D', '2026-10-12/Pre-read.docx', 'kb/S/D/2026-10-12/Pre-read.docx.md')).toBe('kb/S/D/2026-10-12/Pre-read.docx.md');
    expect(undatedOutput('kb/S/D', '2026-10-12/Pre-read.docx', 'kb/S/D/2026-10-13/2026-10-12/Pre-read.docx.md')).toBe('kb/S/D/2026-10-12/Pre-read.docx.md');
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/S/D/Projets/Contrat.docx.md')).toBe('kb/S/D/Projets/Contrat.docx.md');
    expect(undatedOutput('kb/S/D', 'Notes.txt', 'kb/S/D/Notes.txt.md')).toBe('kb/S/D/Notes.txt.md');
  });

  it('a file outside the library, or under a day but not under the folders of its document, stays where it is', () => {
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/elsewhere/2026-05-12/Projets/Contrat.docx.md')).toBe('kb/elsewhere/2026-05-12/Projets/Contrat.docx.md');
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/S/D/2026-05-12/Archive/Contrat.docx.md')).toBe('kb/S/D/2026-05-12/Archive/Contrat.docx.md');
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/S/D/2026-05-12')).toBe('kb/S/D/2026-05-12');
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/S/D/Q3 2026-05-12/Projets/Contrat.docx.md')).toBe('kb/S/D/Q3 2026-05-12/Projets/Contrat.docx.md');
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/S/D/2026-05-12x/Projets/Contrat.docx.md')).toBe('kb/S/D/2026-05-12x/Projets/Contrat.docx.md');
  });

  it('a document in a folder whose name the filesystem cannot hold is matched under its safe name', () => {
    expect(undatedOutput('kb/S/D', 'Projets: 2026/Q1.docx', 'kb/S/D/2026-05-12/Projets_ 2026/Q1.docx.md')).toBe('kb/S/D/Projets_ 2026/Q1.docx.md');
  });
});
