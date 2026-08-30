import { describe, expect, it } from 'bun:test';
import { renderFrontMatter, withFrontMatter, withoutFrontMatter } from './front-matter.ts';

describe('stamping a generated markdown file with where it came from', () => {
  it('a converted document carries its source, its path and when it was synced', () => {
    const rendered = renderFrontMatter([
      ['source', 'https://tenant.sharepoint.com/sites/X/Roadmap.pptx'],
      ['site', 'Espace Contoso'],
      ['path', '/Projets/2026/Roadmap.pptx'],
      ['last_modified', '2026-05-12T09:31:00Z'],
      ['synced_at', '2026-07-23T14:00:00Z'],
    ]);

    expect(rendered).toBe(
      [
        '---',
        'source: https://tenant.sharepoint.com/sites/X/Roadmap.pptx',
        'site: Espace Contoso',
        'path: /Projets/2026/Roadmap.pptx',
        'last_modified: "2026-05-12T09:31:00Z"',
        'synced_at: "2026-07-23T14:00:00Z"',
        '---',
      ].join('\n')
    );
  });

  it('a field that has no value is left out rather than written empty', () => {
    expect(
      renderFrontMatter([
        ['site', 'Espace Contoso'],
        ['modified_by', undefined],
      ])
    ).toBe(['---', 'site: Espace Contoso', '---'].join('\n'));
  });

  it('a document title holding a colon is quoted so the block stays readable as YAML', () => {
    expect(renderFrontMatter([['path', 'Budget: Q1']])).toBe(['---', 'path: "Budget: Q1"', '---'].join('\n'));
  });

  it('a title holding quotes and backslashes is escaped rather than breaking the block', () => {
    expect(renderFrontMatter([['path', 'He said "\\o/"']])).toBe(['---', 'path: "He said \\"\\\\o/\\""', '---'].join('\n'));
  });

  it('a subject spanning two lines is folded into one so the block cannot be broken', () => {
    expect(renderFrontMatter([['subject', 'Contrat\nsigné']])).toBe(['---', 'subject: "Contrat signé"', '---'].join('\n'));
  });

  it('a number is written as a number so a reader can count on it', () => {
    expect(renderFrontMatter([['message_count', 4]])).toBe(['---', 'message_count: 4', '---'].join('\n'));
  });

  it('the files a thread carries are listed one per line', () => {
    expect(renderFrontMatter([['attachments', ['./a.pdf', './b.docx.md']]])).toBe(['---', 'attachments:', '  - ./a.pdf', '  - ./b.docx.md', '---'].join('\n'));
  });

  it('an empty list is left out rather than written as an empty block', () => {
    expect(renderFrontMatter([['attachments', []]])).toBe(['---', '---'].join('\n'));
  });

  it('a value that would read as something other than text is quoted', () => {
    expect(renderFrontMatter([['name', 'true']])).toBe(['---', 'name: "true"', '---'].join('\n'));
    expect(renderFrontMatter([['name', '12']])).toBe(['---', 'name: "12"', '---'].join('\n'));
  });

  it('a comment marker after a space is quoted, since it would swallow the rest of the line', () => {
    expect(renderFrontMatter([['name', 'Budget #1']])).toBe(['---', 'name: "Budget #1"', '---'].join('\n'));
  });

  it('ordinary text that merely contains a keyword, a number or a date is left bare', () => {
    expect(renderFrontMatter([['name', 'Bruno']])).toBe(['---', 'name: Bruno', '---'].join('\n'));
    expect(renderFrontMatter([['name', 'Notes']])).toBe(['---', 'name: Notes', '---'].join('\n'));
    expect(renderFrontMatter([['name', 'Q1 2026']])).toBe(['---', 'name: Q1 2026', '---'].join('\n'));
    expect(renderFrontMatter([['name', 'Rapport 2026-05-12']])).toBe(['---', 'name: Rapport 2026-05-12', '---'].join('\n'));
  });

  it('a run of spaces inside a name is collapsed to one, and the changed value is quoted', () => {
    expect(renderFrontMatter([['name', 'Espace  Contoso']])).toBe(['---', 'name: "Espace Contoso"', '---'].join('\n'));
  });

  it('a name that opens with a digit is quoted, since a reader would take it for a number or a date', () => {
    expect(renderFrontMatter([['name', '2026 budget']])).toBe(['---', 'name: "2026 budget"', '---'].join('\n'));
  });

  it('a value that is only padding is quoted rather than written as nothing', () => {
    expect(renderFrontMatter([['name', '']])).toBe(['---', 'name: ""', '---'].join('\n'));
    expect(renderFrontMatter([['name', '   ']])).toBe(['---', 'name: ""', '---'].join('\n'));
  });

  it('padding around a name is trimmed away, and the trimmed value is quoted so nothing looks lost', () => {
    expect(renderFrontMatter([['name', ' Espace Contoso ']])).toBe(['---', 'name: "Espace Contoso"', '---'].join('\n'));
  });
});

describe('joining the stamp to the converted body', () => {
  it('the body follows the block after one blank line', () => {
    expect(withFrontMatter(renderFrontMatter([['site', 'Espace Contoso']]), '# Roadmap\n\nSlide one.')).toBe(
      ['---', 'site: Espace Contoso', '---', '', '# Roadmap', '', 'Slide one.', ''].join('\n')
    );
  });

  it('a document that converted to nothing still gets its stamp', () => {
    expect(withFrontMatter(renderFrontMatter([['site', 'Espace Contoso']]), '')).toBe(['---', 'site: Espace Contoso', '---', ''].join('\n'));
  });
});

// A stored extract opens with its own stamp. Carrying it into a card that already has one would
// nest two, and a reader would meet a `---` block in the middle of a document.
describe('taking the stamp off a document that already carries one', () => {
  it('the stamp goes and the document it opened stays', () => {
    expect(withoutFrontMatter('---\nsource: x\nsite: y\n---\n\n# Title\n\nBody.')).toBe('# Title\n\nBody.');
  });

  it('a document that never had one is left exactly as it came', () => {
    expect(withoutFrontMatter('# Title\n\nBody.')).toBe('# Title\n\nBody.');
  });

  // A rule between paragraphs is not a stamp, and a document that opens on one is not stamped.
  it('a rule inside the body is left alone', () => {
    expect(withoutFrontMatter('# Title\n\n---\n\nBody.')).toBe('# Title\n\n---\n\nBody.');
  });

  // Trailing newline and all: an unclosed stamp is not a stamp, so the document comes back exactly
  // as it came rather than trimmed on the way through.
  it('a stamp that was never closed is left alone, rather than eating the document', () => {
    expect(withoutFrontMatter('---\nsource: x\n\n# Title')).toBe('---\nsource: x\n\n# Title');
    expect(withoutFrontMatter('---\nsource: x\n\n# Title\n')).toBe('---\nsource: x\n\n# Title\n');
  });

  it('a document that is nothing but its stamp reads as empty', () => {
    expect(withoutFrontMatter('---\nsource: x\n---\n')).toBe('');
  });
});
