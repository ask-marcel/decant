import { linkDestination } from './markdown-link.ts';

// A Windows internet shortcut is a few lines of INI, and the one that matters is `URL=`: where the
// shortcut goes. Only a web address becomes a link. Anything else, a file share or a script, is not
// a place a reader of the vault can follow, so the shortcut is then left unread.
const TARGET_KEY = 'URL=';
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

// Named after the shortcut itself, without the `.url` its name always ends in.
const titleOf = (name: string): string => name.slice(0, name.lastIndexOf('.'));

// The address is parsed rather than copied, so the link holds its normalised form: the carriage
// return a Windows line ends in is gone, and so is any space a link destination would stop at.
export const shortcutLink = (name: string, text: string): string | undefined => {
  const line = text.split('\n').find((candidate) => candidate.startsWith(TARGET_KEY));
  const url = line === undefined ? null : URL.parse(line.slice(TARGET_KEY.length));
  return url !== null && WEB_PROTOCOLS.has(url.protocol) ? `[${titleOf(name)}](${linkDestination(url.href)})` : undefined;
};
