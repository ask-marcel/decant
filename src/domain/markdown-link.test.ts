import { describe, expect, it } from 'bun:test';
import { linkDestination } from './markdown-link.ts';

describe('writing a path a markdown renderer will follow', () => {
  it('a path with nothing awkward in it is written as it stands', () => {
    expect(linkDestination('_attachments/Contrat.docx.md')).toBe('_attachments/Contrat.docx.md');
  });

  // The bug this exists for. Mail attachments are named by people, so spaces are ordinary, and a
  // renderer ends the destination at the first one: the rest of the path became visible text.
  it('a path with a space is wrapped, since a bare destination ends at the first one', () => {
    expect(linkDestination('_attachments/Fw- DC Data -- Pepco.eml.md')).toBe('<_attachments/Fw- DC Data -- Pepco.eml.md>');
  });

  it('a path with a parenthesis is wrapped too, an unbalanced one closing the destination early', () => {
    expect(linkDestination('_attachments/Budget (final).xlsx')).toBe('<_attachments/Budget (final).xlsx>');
  });

  // Inside the wrapped form the angle brackets are what ends it, so they are the one thing that
  // still has to be escaped. A filesystem will accept them; a renderer will not.
  it('an angle bracket in a wrapped path is escaped, being what would end it', () => {
    expect(linkDestination('_attachments/a <b> c.md')).toBe('<_attachments/a \\<b\\> c.md>');
  });

  it('an angle bracket with nothing else awkward is left alone, the bare form not ending on it', () => {
    expect(linkDestination('_attachments/a<b>c.md')).toBe('_attachments/a<b>c.md');
  });
});
