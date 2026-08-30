import { describe, expect, it } from 'bun:test';
import { cardFileName, renderThreadCard } from './thread-card.ts';

const text = (value: string): string => value;

const card = {
  threadId: 'd9f4e0a3c1',
  messageId: '<CAF9x2b71@vendor.cn>',
  filename: 'Contrat.docx',
  sender: 'Jane Doe',
  received: '2026-05-12T09:31:00Z',
  bytes: 412887,
  body: '## 1. Scope\n\nPOS terminals, back office switch…',
  original: '../../../_attachments/Contrat-a1b2c3d4.docx',
};

describe('standing for a file a thread carried', () => {
  // Pinned whole rather than by fragments: this renderer produces a document, and where its blank
  // lines fall is most of what makes it readable.
  it('a card says what arrived, who sent it and when, and where the file itself is kept', () => {
    expect(renderThreadCard(card)).toBe(
      [
        '---',
        'attachment_of: d9f4e0a3c1',
        'message_id: "<CAF9x2b71@vendor.cn>"',
        'filename: Contrat.docx',
        'sender: Jane Doe',
        'received: "2026-05-12T09:31:00Z"',
        'bytes: 412887',
        'original: ../../../_attachments/Contrat-a1b2c3d4.docx',
        '---',
        '',
        '# Contrat.docx',
        '',
        'Carried by Jane Doe on 2026-05-12.',
        '',
        '## 1. Scope',
        '',
        'POS terminals, back office switch…',
        '',
      ].join('\n')
    );
  });

  it('a file nobody could read says why, rather than pointing at nothing', () => {
    const written = renderThreadCard({ ...card, body: undefined, original: undefined, note: 'larger than the 50 MB cap' });

    expect(written).toContain('larger than the 50 MB cap');
    expect(written).not.toContain('## 1. Scope');
  });

  it('a file that was kept whole but never read points only at what was kept', () => {
    const written = renderThreadCard({ ...card, body: undefined });

    expect(written).toContain('original: ../../../_attachments/Contrat-a1b2c3d4.docx');
    expect(written).toContain('Nothing was read out of it.');
  });

  it('a file from nobody in particular still says when it arrived', () => {
    const written = renderThreadCard({ ...card, sender: undefined });

    expect(written).toContain('received: "2026-05-12T09:31:00Z"');
    expect(written).toContain('Carried on 2026-05-12.');
    expect(written).not.toContain('sender:');
  });

  it('a file nothing was read from and nothing explains still says so plainly', () => {
    expect(renderThreadCard({ ...card, body: undefined, original: undefined })).toContain('Nothing was read out of it.');
  });
});

describe('naming a card beside its thread', () => {
  it('a card is named for the file it stands for, so a folder listing reads as an inventory', () => {
    expect(text(cardFileName('Contrat.docx', []))).toBe('Contrat.docx.md');
  });

  // Two attachments of one name in a single thread is ordinary: a form resent after correction
  // keeps its name. Both are kept, since the store holds them apart by content.
  it('a second file of the same name in one thread gets its own card', () => {
    expect(text(cardFileName('Contrat.docx', ['Contrat.docx.md']))).toBe('Contrat-2.docx.md');
    expect(text(cardFileName('Contrat.docx', ['Contrat.docx.md', 'Contrat-2.docx.md']))).toBe('Contrat-3.docx.md');
  });

  it('a file with no extension is numbered without inventing one', () => {
    expect(text(cardFileName('README', ['README.md']))).toBe('README-2.md');
  });

  // A leading dot names a hidden file rather than opening an extension, so the number goes on the
  // end of the whole name instead of in front of what looks like one.
  it('a hidden file is numbered whole, since its leading dot opens no extension', () => {
    expect(text(cardFileName('.gitignore', ['.gitignore.md']))).toBe('.gitignore-2.md');
  });

  it('a name the filesystem could not hold is made safe before it becomes a path', () => {
    expect(text(cardFileName('Q1/Q2 budget.xlsx', []))).toBe('Q1_Q2 budget.xlsx.md');
  });
});
