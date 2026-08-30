import { describe, expect, it } from 'bun:test';
import { renderLinkCard } from './link-card.ts';

const card = {
  threadId: 'd9f4e0a3c1',
  title: 'Rapport.docx',
  url: 'https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx',
  inMessage: '2026-05-12T09:31:00Z',
  lastModified: '2026-05-11T08:00:00Z',
  modifiedBy: 'Jane Doe',
  body: 'Q3 was ahead of plan.',
  original: 'Rapport.docx',
};

describe('standing for a file a thread pointed at', () => {
  // Pinned whole: this renderer produces a document, and its blank lines are most of what makes it
  // readable. The same reason the thread card is pinned whole.
  it('a card says what was pointed at, where it lives at the source, and what it turned out to say', () => {
    expect(renderLinkCard(card)).toBe(
      [
        '---',
        'linked_from: d9f4e0a3c1',
        'title: Rapport.docx',
        'url: https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx',
        'in_message: "2026-05-12T09:31:00Z"',
        'last_modified: "2026-05-11T08:00:00Z"',
        'modified_by: Jane Doe',
        'original: Rapport.docx',
        '---',
        '',
        '# Rapport.docx',
        '',
        'Pointed at on 2026-05-12.',
        '',
        'Q3 was ahead of plan.',
        '',
      ].join('\n')
    );
  });

  // The card is the only record that the thread depended on something the knowledge base does not
  // hold. Dropping it would make the gap invisible.
  it('a file that was never pulled still gets a card, saying why it is not here', () => {
    const written = renderLinkCard({ ...card, body: undefined, original: undefined, note: 'larger than the 50 MB cap' });

    expect(written).toContain('larger than the 50 MB cap');
    expect(written).toContain('url: https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx');
    expect(written).not.toContain('original:');
  });

  // Pinned whole for the same reason the pulled one is: what a card says when there is nothing to
  // say is most of its value, and a stray `undefined` in the body would read as a document.
  it('a file that was never pulled and gives no reason still says it is not here', () => {
    expect(renderLinkCard({ ...card, body: undefined, original: undefined, lastModified: undefined, modifiedBy: undefined })).toBe(
      [
        '---',
        'linked_from: d9f4e0a3c1',
        'title: Rapport.docx',
        'url: https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx',
        'in_message: "2026-05-12T09:31:00Z"',
        '---',
        '',
        '# Rapport.docx',
        '',
        'Pointed at on 2026-05-12. It was not pulled into the knowledge base.',
        '',
      ].join('\n')
    );
  });

  // A document read for its text and not kept as bytes, which is what happens to anything the
  // converter can read whole. The card is then the only copy, and there is nothing to name.
  it('a document read but not kept names no original, there being no file beside the card', () => {
    expect(renderLinkCard({ ...card, original: undefined })).not.toContain('original:');
  });
});
