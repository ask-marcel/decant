import { describe, expect, it } from 'bun:test';
import { carriesInlineImage, inlineImageLabels, linkInlineImages, pairInlineImages } from './inline-image.ts';

// The converter runs the body through turndown, which escapes the brackets, so this is the shape a
// placeholder really arrives in. The bare form is kept working too: the escaping is not a contract.
const ESCAPED = 'Regards,\n\n\\[inline image: image931066.png\\]';

describe('spotting a picture the body shows but does not carry', () => {
  it('a message with no picture in it carries none', () => {
    expect(carriesInlineImage('Hi Vincent,\n\nNo pictures here.')).toBe(false);
  });

  it('the escaped form the converter emits is still recognised', () => {
    expect(carriesInlineImage(ESCAPED)).toBe(true);
  });

  it('the bare form is recognised as well, since the escaping is not promised', () => {
    expect(carriesInlineImage('[inline image: logo.png]')).toBe(true);
  });

  it('the pictures a message shows are named in the order they appear', () => {
    expect(inlineImageLabels('\\[inline image: first.png\\] then \\[inline image: second.gif\\]')).toEqual(['first.png', 'second.gif']);
  });
});

describe('deciding which picture a placeholder stands for', () => {
  // Two pictures in the message throughout, so a pairing can only come from the label answering one
  // of them. With a single picture the last resort below would rescue every case and prove nothing.
  const signature = { name: 'image931066.png', contentId: 'image931066.png@1B0A3865.2858A107' };
  const pasted = { name: 'Outlook-14zeyefg.png', contentId: '' };

  it('a placeholder naming the file is answered by that file', () => {
    expect(pairInlineImages(['image931066.png'], [pasted, signature])).toEqual([{ label: 'image931066.png', image: signature }]);
  });

  it('a placeholder naming the whole content id is answered too', () => {
    expect(pairInlineImages(['image931066.png@1B0A3865.2858A107'], [pasted, signature])).toEqual([{ label: 'image931066.png@1B0A3865.2858A107', image: signature }]);
  });

  it('a placeholder naming a content id cut at its at-sign is answered by that picture', () => {
    const screenshot = { name: 'Outlook-1jfz4bds.gif', contentId: 'a4f0b1c2@01DC1234.5678ABCD' };

    expect(pairInlineImages(['a4f0b1c2'], [pasted, screenshot])).toEqual([{ label: 'a4f0b1c2', image: screenshot }]);
  });

  it('one placeholder nothing answers and one picture nothing claims are taken for each other', () => {
    expect(pairInlineImages(['image931066.png', 'screenshot'], [pasted, signature])).toEqual([
      { label: 'image931066.png', image: signature },
      { label: 'screenshot', image: pasted },
    ]);
  });

  it('two placeholders nothing answers are left alone rather than guessed at', () => {
    const first = { name: 'a.png', contentId: '' };
    const second = { name: 'b.png', contentId: '' };

    expect(pairInlineImages(['one', 'two'], [first, second])).toEqual([]);
  });

  it('a placeholder nothing answers beside two spare pictures is left alone as well', () => {
    expect(pairInlineImages(['mystery'], [pasted, signature])).toEqual([]);
  });

  it('a message showing a picture it never carried pairs nothing', () => {
    expect(pairInlineImages(['gone.png'], [])).toEqual([]);
  });
});

describe('putting the picture back where the message showed it', () => {
  it('a placeholder becomes the picture itself, pointing at where it landed', () => {
    const linked = linkInlineImages(ESCAPED, [{ label: 'image931066.png', path: '../../_attachments/image931066-a1b2c3d4.png' }]);

    expect(linked).toBe('Regards,\n\n![image931066.png](../../_attachments/image931066-a1b2c3d4.png)');
  });

  it('the bare form is replaced the same way', () => {
    expect(linkInlineImages('[inline image: logo.png]', [{ label: 'logo.png', path: './logo.png' }])).toBe('![logo.png](./logo.png)');
  });

  it('a placeholder no picture was found for is left exactly as it stands', () => {
    expect(linkInlineImages(ESCAPED, [])).toBe(ESCAPED);
  });

  it('the same picture shown twice is put back both times', () => {
    const linked = linkInlineImages('\\[inline image: logo.png\\] and \\[inline image: logo.png\\]', [{ label: 'logo.png', path: './logo.png' }]);

    expect(linked).toBe('![logo.png](./logo.png) and ![logo.png](./logo.png)');
  });
});
