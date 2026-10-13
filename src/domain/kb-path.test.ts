import { describe, expect, it } from 'bun:test';
import { disambiguateSegment, fitSegment, freePath, memberFile, safeRelPath, safeSegment } from './kb-path.ts';

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

  // A To Do title cut there became `… (just .md`, with the space before the extension the caller adds.
  it('a long name cut just after a space ends without it', () => {
    expect(text(safeSegment(`${'a'.repeat(179)} ${'b'.repeat(50)}`))).toBe('a'.repeat(179));
  });

  it('a long name keeps its extension when it is cut, so the file still opens with the right program', () => {
    const shortened = text(safeSegment(`${'a'.repeat(300)}.docx`));

    expect(shortened).toHaveLength(180);
    expect(shortened.endsWith('a.docx')).toBe(true);
  });

  it('a long title whose last dot opens no extension is cut like any other text', () => {
    expect(text(safeSegment(`deck v1.2 ${'x'.repeat(300)}`))).toBe(`deck v1.2 ${'x'.repeat(170)}`);
  });

  it('a cut never splits a character in two', () => {
    expect(text(safeSegment(`${'a'.repeat(179)}😀b`))).toBe('a'.repeat(179));
  });

  it('a name that Windows keeps for a device takes an underscore, with or without an extension', () => {
    const reserved = ['CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9'];

    for (const name of reserved) {
      expect(text(safeSegment(name))).toBe(`${name}_`);
      expect(text(safeSegment(`${name}.txt`))).toBe(`${name}_.txt`);
    }
  });

  it('a name that only starts like a device name is written as it is', () => {
    expect(['CONTRACT.docx', 'console', 'com0', 'lpt10.txt', 'nullable.md'].map((name) => text(safeSegment(name)))).toEqual([
      'CONTRACT.docx',
      'console',
      'com0',
      'lpt10.txt',
      'nullable.md',
    ]);
  });

  // An attachment or a zip entry can carry one of these, and git obeys a `.gitignore` it finds in a
  // kb kept in git, and skips a `.git` folder.
  it('a name that git reads as its own takes an underscore in front', () => {
    expect(['.git', '.gitignore', '.GitAttributes', '.gitmodules'].map((name) => text(safeSegment(name)))).toEqual(['_.git', '_.gitignore', '_.GitAttributes', '_.gitmodules']);
    expect(['.github', 'x.gitignore', '.gitkeep'].map((name) => text(safeSegment(name)))).toEqual(['.github', 'x.gitignore', '.gitkeep']);
  });

  it('accented names are normalised so the same document never lands twice', () => {
    expect(text(safeSegment('Clément.docx'))).toBe('Clément.docx');
  });

  it('a folder trail becomes a relative path under the knowledge base', () => {
    expect(text(safeRelPath(['Espace Contoso', 'Projets: 2026', 'Roadmap.pptx']))).toBe('Espace Contoso/Projets_ 2026/Roadmap.pptx');
  });

  it('empty folder names are dropped rather than producing a doubled separator', () => {
    expect(text(safeRelPath(['Espace Contoso', '', 'Roadmap.pptx']))).toBe('Espace Contoso/Roadmap.pptx');
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

  it('a name too long to keep whole is shortened around its suffix, never out of it', () => {
    const suffixed = text(disambiguateSegment(`${'a'.repeat(300)}.docx`, '01ABCDEF2345'));

    expect(suffixed).toHaveLength(180);
    expect(suffixed.endsWith('-01ABCDEF.docx')).toBe(true);
  });

  it('a name whose extension alone overruns the limit still opens with its suffix', () => {
    const suffixed = text(disambiguateSegment(`Rapport.${'z'.repeat(300)}`, '01ABCDEF2345'));

    expect(suffixed.startsWith('-01ABCDEF.')).toBe(true);
  });

  it('two long names alike up to the cut are still told apart by what they hold', () => {
    const first = text(disambiguateSegment(`${'a'.repeat(300)} v1.docx`, '01ABCDEF2345'));
    const second = text(disambiguateSegment(`${'a'.repeat(300)} v2.docx`, '9988776655FF'));

    expect(first).not.toBe(second);
  });
});

// Windows and macOS take `Report.md` and `report.md` for one file, so the second write would replace
// the first without a word.
describe('telling names apart the way the disk does', () => {
  it('a name held by another item in other letter case counts as taken, so the second item takes its own suffix', () => {
    const file = freePath('kb/To Do/Tasks/2026-09-08', 'call mark.md', 'id-2', new Set(['kb/To Do/Tasks/2026-09-08/Call Mark.md']));

    expect(file).not.toBe('kb/To Do/Tasks/2026-09-08/call mark.md');
    expect(file).toStartWith('kb/To Do/Tasks/2026-09-08/call mark-');
  });

  // Written over in place, the file keeps the case it was first named in. Renamed to the new case,
  // the next step would put the old path aside, and on such a disk that path is the fresh note.
  it('an item whose title changed only in letter case keeps its own file as it is', () => {
    const own = 'kb/To Do/Tasks/2026-09-08/Call Mark.md';

    expect(freePath('kb/To Do/Tasks/2026-09-08', 'call mark.md', 'id-1', new Set([own]), own)).toBe(own);
  });

  it('an item that moved to another folder is not held back by its old file in other case', () => {
    const own = 'kb/To Do/Tasks/2026-09-08/Call Mark.md';

    expect(freePath('kb/To Do/Tasks/2026-09-09', 'call mark.md', 'id-1', new Set([own]), own)).toBe('kb/To Do/Tasks/2026-09-09/call mark.md');
  });
});

// Windows refuses a path longer than 259 characters. The budget counts the path as decant writes it,
// and room is left below each name for what comes later: `.md`, a picture under `.media/`, the
// `_archive/<day>/` an old copy moves under, and a namesake's suffix.
describe('keeping a path short enough for Windows', () => {
  const folder = `kb/${'f'.repeat(97)}`;

  it('a name whose path fits is kept as it is, and so is any name when no budget is given', () => {
    expect(fitSegment('kb/To Do/Tasks/2026-09-08', 'Call Mark.md', 259)).toBe('Call Mark.md');
    expect(fitSegment(folder, `${'a'.repeat(300)}.docx`, undefined)).toBe(`${'a'.repeat(300)}.docx`);
  });

  it('a name that would carry its path past the budget is cut, keeping its extension and taking a hash of the whole name', () => {
    const fitted = fitSegment(folder, `${'a'.repeat(150)}.docx`, 259);

    expect(fitted).toHaveLength(103);
    expect(fitted).toMatch(/^a{89}-[0-9a-f]{8}\.docx$/);
  });

  it('a name that fills the budget exactly is kept, and one a character longer is cut', () => {
    expect(fitSegment(folder, `${'a'.repeat(98)}.docx`, 259)).toBe(`${'a'.repeat(98)}.docx`);
    expect(fitSegment(folder, `${'a'.repeat(99)}.docx`, 259)).toHaveLength(103);
  });

  it('two long names cut alike stay apart', () => {
    expect(fitSegment(folder, `${'a'.repeat(150)} v1.docx`, 259)).not.toBe(fitSegment(folder, `${'a'.repeat(150)} v2.docx`, 259));
  });

  it('a planned file is fitted to the budget it is given, and planned as before when none is given', () => {
    expect(freePath(folder, `${'a'.repeat(150)}.md`, 'id-1', new Set(), undefined, 259)).toHaveLength(204);
    expect(freePath(folder, `${'a'.repeat(150)}.md`, 'id-1', new Set())).toBe(`${folder}/${'a'.repeat(150)}.md`);
  });
});

describe('naming the file a zip member lands in', () => {
  it('a member keeps the folders it had inside the archive, made safe, and gains .md', () => {
    expect(memberFile('kb/T/_attachments/Scans', 'week 1/check: C1.html', undefined)).toBe('kb/T/_attachments/Scans/week 1/check_ C1.html.md');
  });

  it('a member whose path would run past the budget has its own name cut, and its folders kept', () => {
    const file = memberFile(`kb/${'f'.repeat(97)}`, `deep/${'m'.repeat(150)}.html`, 259);

    expect(file).toStartWith(`kb/${'f'.repeat(97)}/deep/${'m'.repeat(80)}`);
    expect(file).toMatch(/-[0-9a-f]{8}\.md$/);
    expect(file).toHaveLength(204);
  });
});
