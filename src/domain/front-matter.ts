export type FrontMatterValue = string | number | ReadonlyArray<string>;

export type FrontMatterField = readonly [key: string, value: FrontMatterValue | undefined];

// Names and subjects come from SharePoint and Outlook, so they may hold anything. Three rules keep
// a value bare: it must open with a character that starts no YAML construct and no number or date
// (so a URL and a path stay bare while a timestamp is quoted), it must carry no syntax that would
// end the value early, and it must not read as a boolean or null.
const BARE_START = /^[A-Za-z_/.]/;
const SYNTAX = /:\s|\s#|["\\]/;
const COERCIBLE = /^(true|false|null|yes|no|on|off|~)$/i;

const needsQuoting = (raw: string, folded: string): boolean => folded !== raw || !BARE_START.test(folded) || SYNTAX.test(folded) || COERCIBLE.test(folded);

const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const scalar = (raw: string): string => {
  const folded = raw.replace(/\s+/g, ' ').trim();
  return needsQuoting(raw, folded) ? quote(folded) : folded;
};

const renderField = (key: string, value: FrontMatterValue): ReadonlyArray<string> => {
  if (typeof value === 'number') return [`${key}: ${value}`];
  if (typeof value === 'string') return [`${key}: ${scalar(value)}`];
  return [`${key}:`, ...value.map((entry) => `  - ${scalar(entry)}`)];
};

const isEmpty = (value: FrontMatterValue | undefined): boolean => value === undefined || (Array.isArray(value) && value.length === 0);

export const renderFrontMatter = (fields: ReadonlyArray<FrontMatterField>): string => {
  const lines = fields.filter(([, value]) => !isEmpty(value)).flatMap(([key, value]) => renderField(key, value as FrontMatterValue));
  return ['---', ...lines, '---'].join('\n');
};

const withoutTrailingNewlines = (body: string): string => {
  let end = body.length;
  while (end > 0 && body[end - 1] === '\n') end -= 1;
  return body.slice(0, end);
};

// Generated files end with exactly one newline, the way every other text file on disk does.
export const withFrontMatter = (frontMatter: string, body: string): string => (body.length === 0 ? `${frontMatter}\n` : `${frontMatter}\n\n${withoutTrailingNewlines(body)}\n`);

const FENCE = '---';

const NOT_FOUND = -1;

// The stamp off a document that already carries one, so it can be carried into another that has its
// own. Only a stamp: a document must OPEN with the fence, and the fence must close, or it is left
// exactly as it came. A rule between paragraphs is not a stamp, and half a stamp is not one either,
// so neither is allowed to eat the document.
export const withoutFrontMatter = (document: string): string => {
  const lines = document.split('\n');
  if (lines[0] !== FENCE) return document;
  // Exactly "not found": searched from the second line, `indexOf` answers -1 or an index of at least
  // one, never zero, so a `< 0` test carries a case nothing can reach.
  const close = lines.indexOf(FENCE, 1);
  return close === NOT_FOUND
    ? document
    : lines
        .slice(close + 1)
        .join('\n')
        .trim();
};
