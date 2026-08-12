import { describe, expect, it } from 'bun:test';
import { archivePath, datedRoot, outputPrefix, recordedPrefix, remapOutputs } from './output-paths.ts';

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

describe('putting aside what SharePoint no longer has', () => {
  it('an archived file keeps the place it had inside the library', () => {
    expect(archivePath('kb/_archive/Site/Documents', 'kb/Site/Documents', 'kb/Site/Documents/Projets/Old.docx.md')).toBe('kb/_archive/Site/Documents/Projets/Old.docx.md');
  });

  it('a file recorded outside the library is still put aside rather than left behind', () => {
    expect(archivePath('kb/_archive/Site/Documents', 'kb/Site/Documents', 'kb/other/Old.md')).toBe('kb/_archive/Site/Documents/kb/other/Old.md');
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
