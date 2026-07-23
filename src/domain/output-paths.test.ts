import { describe, expect, it } from 'bun:test';
import { archivePath, outputPrefix, remapOutputs } from './output-paths.ts';

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
