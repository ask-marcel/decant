import { describe, expect, it } from 'bun:test';
import { datedRoot, outputPrefix } from './output-paths.ts';

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
