import { describe, expect, it } from 'bun:test';
import { disambiguateSegment, safeRelPath, safeSegment } from './kb-path.ts';

// The factories return branded strings; the assertions compare them as the text they are.
const text = (value: string): string => value;

// Every character this tool refuses to write into a path. A row leaving this list changes what
// lands on disk, so the whole list is pinned rather than a sample of it.
const FORBIDDEN = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

describe('the characters a name cannot keep', () => {
  for (const char of FORBIDDEN) {
    it(`a name holding ${char} has it replaced`, () => {
      expect(text(safeSegment(`Rapport${char}final`))).toBe('Rapport_final');
    });
  }
});

describe('turning a SharePoint name into somewhere safe to write', () => {
  it('a name that is already safe is written exactly as it is', () => {
    expect(text(safeSegment('Roadmap 2026.pptx'))).toBe('Roadmap 2026.pptx');
  });

  it('characters the filesystem cannot hold are replaced so the file still lands', () => {
    expect(text(safeSegment('Q1/Q2: budget <final>?'))).toBe('Q1_Q2_ budget _final__');
  });

  it('a name that tries to climb out of the knowledge base cannot escape it', () => {
    expect(text(safeSegment('..'))).toBe('_');
    expect(text(safeSegment('.'))).toBe('_');
  });

  it('a name made only of forbidden characters still yields something writable', () => {
    expect(text(safeSegment('///'))).toBe('___');
    expect(text(safeSegment('   '))).toBe('_');
  });

  it('control characters smuggled into a name are replaced', () => {
    expect(text(safeSegment('Rapport\u0007\u001Ffinal.docx'))).toBe('Rapport__final.docx');
  });

  it('trailing dots and spaces are dropped, which some filesystems refuse to store', () => {
    expect(text(safeSegment('Rapport final. '))).toBe('Rapport final');
  });

  it('a name longer than a path component can hold is shortened', () => {
    const shortened = text(safeSegment(`${'a'.repeat(300)}.docx`));

    expect(shortened).toHaveLength(180);
    expect(shortened.startsWith('aaa')).toBe(true);
  });

  it('accented names are normalised so the same document never lands twice', () => {
    expect(text(safeSegment('Clément.docx'))).toBe('Clément.docx');
  });

  it('a folder trail becomes a relative path under the knowledge base', () => {
    expect(text(safeRelPath(['Espace MOOV', 'Projets: 2026', 'Roadmap.pptx']))).toBe('Espace MOOV/Projets_ 2026/Roadmap.pptx');
  });

  it('empty folder names are dropped rather than producing a doubled separator', () => {
    expect(text(safeRelPath(['Espace MOOV', '', 'Roadmap.pptx']))).toBe('Espace MOOV/Roadmap.pptx');
  });
});

describe('keeping two documents with the same name apart', () => {
  it('the second document keeps its extension and takes a suffix from its item id', () => {
    expect(text(disambiguateSegment('Contrat.pdf', '01ABCDEF2345'))).toBe('Contrat-01ABCDEF.pdf');
  });

  it('a name with no extension takes the suffix at the end', () => {
    expect(text(disambiguateSegment('Contrat', '01ABCDEF2345'))).toBe('Contrat-01ABCDEF');
  });

  it('a name carrying two extensions keeps the last one', () => {
    expect(text(disambiguateSegment('Rapport.docx.md', '01ABCDEF2345'))).toBe('Rapport.docx-01ABCDEF.md');
  });

  it('a hidden file is suffixed without losing its leading dot', () => {
    expect(text(disambiguateSegment('.sync-state.json', '01ABCDEF2345'))).toBe('.sync-state-01ABCDEF.json');
  });

  it('a name that is nothing but a leading dot and a word takes the suffix at the end', () => {
    expect(text(disambiguateSegment('.json', '01ABCDEF2345'))).toBe('.json-01ABCDEF');
  });
});
