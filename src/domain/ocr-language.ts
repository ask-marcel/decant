// Which model read an image can only be decided after something has read it, and only one of the
// recognizers can answer in both directions: RapidOCR's `ch` dictionary holds 6270 ideographs
// alongside its ASCII, where the Latin ones hold no CJK at all. So a `ch` reading showing no
// ideographs is real evidence the image held none, and the run can go back over it with the model
// that keeps word spacing.
const IDEOGRAPH = /[一-鿿]/u;

const BLANK = /\s/u;

// A share rather than a single ideograph: `ch` misreads the odd logo or glyph on an English page,
// and one such character should not send a whole page to the model that runs its words together.
// Blank space is left out of the count so a sparse layout does not dilute what the page says.
const CHINESE_SHARE = 0.02;

export const holdsChineseText = (text: string): boolean => {
  const written = [...text].filter((character) => !BLANK.test(character));
  const ideographs = written.filter((character) => IDEOGRAPH.test(character)).length;
  return ideographs > written.length * CHINESE_SHARE;
};
