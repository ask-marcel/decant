import { describe, expect, it } from 'bun:test';
import { FILE_SLUG_LIMIT, FOLDER_SLUG_LIMIT, NO_SUBJECT, slugify } from './thread-slug.ts';

describe('naming a thread after what it is about', () => {
  it('a subject becomes a name a filesystem will take', () => {
    expect(slugify('Rimowa TW store opening, IT scope', FILE_SLUG_LIMIT)).toBe('rimowa-tw-store-opening-it-scope');
  });

  it('punctuation between words becomes one separator, however much of it there was', () => {
    expect(slugify('Contrat  --  Contoso / 2026', FILE_SLUG_LIMIT)).toBe('contrat-contoso-2026');
  });

  it('accents are folded so a name can be typed', () => {
    expect(slugify('Rimowa Café', FILE_SLUG_LIMIT)).toBe('rimowa-cafe');
    expect(slugify('Réunion à Genève', FILE_SLUG_LIMIT)).toBe('reunion-a-geneve');
  });

  // Folding a combining mark off a kana turns が into か, a different word. Only Latin letters are
  // decomposed, so every other script survives the fold that makes Latin typeable.
  it('CJK is left exactly as it was, since it is readable and a filesystem takes it', () => {
    expect(slugify('开业时间 10:00-22:00', FILE_SLUG_LIMIT)).toBe('开业时间-10-00-22-00');
    expect(slugify('がんばって', FILE_SLUG_LIMIT)).toBe('がんばって');
    expect(slugify('회신 완료', FILE_SLUG_LIMIT)).toBe('회신-완료');
  });

  it('a long subject is cut at a word, not through one', () => {
    expect(slugify('Preventive security notification for the payment integration exposure', FOLDER_SLUG_LIMIT)).toBe('preventive-security-notification-for');
  });

  it('a subject too long to break anywhere is cut where it must be, rather than left to break a path', () => {
    expect(slugify('a'.repeat(80), FOLDER_SLUG_LIMIT)).toHaveLength(FOLDER_SLUG_LIMIT);
  });

  it('a subject short enough is left whole', () => {
    expect(slugify('Kick-off', FOLDER_SLUG_LIMIT)).toBe('kick-off');
  });

  it('punctuation trailing a subject leaves no separator hanging off the name', () => {
    expect(slugify('Kick-off!', FOLDER_SLUG_LIMIT)).toBe('kick-off');
  });

  // Exactly the limit, which is the boundary the cut is decided on: one character either side of it
  // takes a different branch, and only the equal case says which way the boundary itself falls.
  it('a subject that comes to exactly the limit is left whole rather than cut back a word', () => {
    expect(slugify('abcd efgh ijkl mnop qrst uvwx yzab cdefg', FOLDER_SLUG_LIMIT)).toBe('abcd-efgh-ijkl-mnop-qrst-uvwx-yzab-cdefg');
  });

  it('a subject with nothing usable in it still names a folder', () => {
    expect(slugify('!!! ???', FILE_SLUG_LIMIT)).toBe('no-subject');
    expect(slugify('', FILE_SLUG_LIMIT)).toBe(NO_SUBJECT);
  });
});
