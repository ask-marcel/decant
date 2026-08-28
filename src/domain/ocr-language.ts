// Which model read an image can only be decided after something has read it, and only the widest
// recognizer can answer for every script at once: RapidOCR's `ch` at PP-OCRv5 holds 15565
// ideographs, both kana syllabaries and the accented Latin letters, where each dedicated model
// holds one script and is blind to the rest. So one reading by that model says what the image is
// in, and the run goes back over it with the model built for what it found.
export type ReadingScript = 'japanese' | 'chinese' | 'latin';

// Kana are what separate Japanese from Chinese: both are written in ideographs, only one of them
// also carries a syllabary. Hiragana and katakana sit in one continuous range.
const KANA = /[぀-ヿ]/u;

const IDEOGRAPH = /[一-鿿]/u;

const BLANK = /\s/u;

// A share rather than a single character: a recognizer misreads the odd logo or glyph, and one such
// character should not send a whole page to the wrong model. Blank space is left out of the count
// so a sparse layout does not dilute what the page says.
const SHARE = 0.02;

// Multiplied rather than divided so an empty reading needs no guard in front of it: nothing is more
// than nothing, where a division would have to answer for 0/0 first.
const holds = (written: ReadonlyArray<string>, script: RegExp): boolean => written.filter((character) => script.test(character)).length > written.length * SHARE;

export const scriptOf = (text: string): ReadingScript => {
  const written = [...text].filter((character) => !BLANK.test(character));
  if (holds(written, KANA)) return 'japanese';
  return holds(written, IDEOGRAPH) ? 'chinese' : 'latin';
};
