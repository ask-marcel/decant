import { describe, expect, it } from 'bun:test';
import { kbDocument, stampOf } from './kb-document.ts';

const base = {
  source: 'https://tenant.sharepoint.com/sites/X/Roadmap.pptx',
  site: 'Espace MOOV',
  library: 'Documents',
  path: 'Projets/Roadmap.pptx',
  lastModified: '2026-05-12T09:31:00Z',
  syncedAt: '2026-07-23T14:00:00Z',
};

describe('stamping a converted document', () => {
  it('a deck records the PDF sitting beside it so an agent can look at the slides', () => {
    expect(stampOf({ ...base, modifiedBy: 'Jane Doe', pdf: './Roadmap.pptx.pdf' })).toBe(
      [
        '---',
        'source: https://tenant.sharepoint.com/sites/X/Roadmap.pptx',
        'site: Espace MOOV',
        'library: Documents',
        'path: Projets/Roadmap.pptx',
        'last_modified: "2026-05-12T09:31:00Z"',
        'modified_by: Jane Doe',
        'synced_at: "2026-07-23T14:00:00Z"',
        'pdf: ./Roadmap.pptx.pdf',
        '---',
      ].join('\n')
    );
  });

  it('a photo records the image beside it and how its text was read', () => {
    const stamp = stampOf({ ...base, path: 'Photos/Tableau.jpg', image: './Tableau.jpg', ocr: 'paddleocr (en)' });

    expect(stamp).toContain('image: ./Tableau.jpg');
    expect(stamp).toContain('ocr: paddleocr (en)');
  });

  it('a file converted from inside an archive records where it sat in the archive', () => {
    expect(stampOf({ ...base, zipEntry: 'livraison/notes.docx' })).toContain('zip_entry: livraison/notes.docx');
  });

  it('a document whose modifier is unknown simply omits that line', () => {
    expect(stampOf(base)).not.toContain('modified_by');
  });

  it('the converted text follows the stamp', () => {
    expect(kbDocument(base, '# Roadmap')).toContain('---\n\n# Roadmap');
  });
});
