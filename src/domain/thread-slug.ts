// A thread's name, cut to length twice. The folder is a prefix of every path beneath it, including a
// zip inside a nested message, so it stays short. The file appears only in the thread document's own
// path, which is the shallowest in the vault, so it can afford the fuller title.
export const FILE_SLUG_LIMIT = 60;
export const FOLDER_SLUG_LIMIT = 40;

// Subject-less mail is ordinary, and a folder still needs a name a person can read.
export const NO_SUBJECT = 'no-subject';

// Only Latin runs are decomposed. Stripping every combining mark instead would turn が into か, a
// different word, while claiming to leave CJK alone.
const LATIN_RUN = /[a-zÀ-ɏ]/g;

const COMBINING = /[̀-ͯ]/g;

// What survives into a name: ASCII letters and digits, and the scripts this mailbox actually sees
// written. Everything between them collapses to one separator.
const SEPARATOR = /[^a-z0-9぀-ヿ一-鿿가-힯]+/g;

// One character each, not a run. Runs have already collapsed to a single separator by the time
// these are applied, so `-+` would only add the backtracking that makes a long name quadratic.
const LEADING_SEPARATOR = /^-/;

const TRAILING_SEPARATOR = /-$/;

const trimSeparators = (slug: string): string => slug.replace(LEADING_SEPARATOR, '').replace(TRAILING_SEPARATOR, '');

const foldLatin = (text: string): string => text.replace(LATIN_RUN, (run) => run.normalize('NFD').replace(COMBINING, ''));

// Cut back to the last separator inside the limit, so a name ends on a word. A single word longer
// than the whole limit has no separator to fall back to and is cut where it must be: a path that is
// too long is worse than a word that is.
const cutToWord = (slug: string, limit: number): string => {
  if (slug.length <= limit) return slug;
  const head = slug.slice(0, limit);
  const lastSeparator = head.lastIndexOf('-');
  return lastSeparator < 0 ? head : head.slice(0, lastSeparator);
};

export const slugify = (text: string, limit: number): string => {
  const slug = trimSeparators(foldLatin(text.toLowerCase()).replace(SEPARATOR, '-'));
  const cut = trimSeparators(cutToWord(slug, limit));
  return cut.length === 0 ? NO_SUBJECT : cut;
};
