import { describe, expect, it } from 'bun:test';
import { renderLinkCard } from './link-card.ts';

const card = {
  threadId: 'd9f4e0a3c1',
  title: 'Rapport.docx',
  url: 'https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx',
  inMessage: '2026-05-12T09:31:00Z',
  holds: '../../../_linked/2026-05-11/Rapport.docx.md',
};

describe('standing for a file a thread pointed at', () => {
  // Pinned whole: this renderer produces a document, and its blank lines are most of what makes it
  // readable. The same reason the thread card is pinned whole.
  it('a card says what was pointed at, where it lives at the source, and where the copy is', () => {
    expect(renderLinkCard(card)).toBe(
      [
        '---',
        'linked_from: d9f4e0a3c1',
        'title: Rapport.docx',
        'url: https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx',
        'in_message: "2026-05-12T09:31:00Z"',
        'holds: ../../../_linked/2026-05-11/Rapport.docx.md',
        '---',
        '',
        '# Rapport.docx',
        '',
        'Pointed at on 2026-05-12, and pulled into [the shared store](../../../_linked/2026-05-11/Rapport.docx.md),',
        'where it is held once however many threads pointed at it.',
        '',
      ].join('\n')
    );
  });

  // The card is the only record that the thread depended on something the knowledge base does not
  // hold. Dropping it would make the gap invisible.
  it('a file that was never pulled still gets a card, saying why it is not here', () => {
    const written = renderLinkCard({ ...card, holds: undefined, note: 'larger than the 50 MB cap' });

    expect(written).toContain('larger than the 50 MB cap');
    expect(written).toContain('url: https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx');
    expect(written).not.toContain('holds:');
  });

  it('a file that was never pulled and gives no reason still says it is not here', () => {
    expect(renderLinkCard({ ...card, holds: undefined })).toContain('It was not pulled into the knowledge base.');
  });
});
