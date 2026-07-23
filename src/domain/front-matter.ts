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
