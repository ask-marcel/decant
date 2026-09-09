// Graph hands its own cursors back percent-escaped, and feeding one to `next-page` needs the same
// canonicalization the library's CLI presenter applies before it prints one: `%24` back to `$`, and
// every other escape left exactly as it came. Shared because three collections now follow a cursor
// (drive items, mail messages, To Do tasks) and a fourth copy of the rule is a fourth chance to get
// it wrong in one place only.
export const canonicalCursor = (link: string | undefined): string | undefined => link?.replace(/%24/gi, '$');
