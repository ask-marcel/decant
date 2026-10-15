import { describe, expect, it } from 'bun:test';
import { datedRoot, outputPrefix, undatedOutput } from './output-paths.ts';

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

  it("a document's own folders sit under the day, so two of the same name stay apart", () => {
    const day = datedRoot('kb/Site/Documents', '2026-05-12T09:31:00Z');

    expect(outputPrefix(day, 'A/report.docx')).toBe('kb/Site/Documents/2026-05-12/A/report.docx');
    expect(outputPrefix(day, 'B/report.docx')).toBe('kb/Site/Documents/2026-05-12/B/report.docx');
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
    expect(undatedOutput('kb/S/D', 'Roadmap.pptx', 'kb/S/D/undated')).toBe('kb/S/D/undated');
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/X/Y/2026-05-12/Projets/Contrat.docx.md')).toBe('kb/X/Y/2026-05-12/Projets/Contrat.docx.md');
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/S/D/Q3 2026-05-12/Projets/Contrat.docx.md')).toBe('kb/S/D/Q3 2026-05-12/Projets/Contrat.docx.md');
    expect(undatedOutput('kb/S/D', 'Projets/Contrat.docx', 'kb/S/D/2026-05-12x/Projets/Contrat.docx.md')).toBe('kb/S/D/2026-05-12x/Projets/Contrat.docx.md');
  });

  it('a document in a folder whose name the filesystem cannot hold is matched under its safe name', () => {
    expect(undatedOutput('kb/S/D', 'Projets: 2026/Q1.docx', 'kb/S/D/2026-05-12/Projets_ 2026/Q1.docx.md')).toBe('kb/S/D/Projets_ 2026/Q1.docx.md');
  });
});
