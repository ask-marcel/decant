// The one line a note carries that changes on every write whatever the source says: when it was
// synced. Written again over a note that differs only there, the file changes with nothing new in
// it, and every copy of the knowledge base (a backup, git, OneDrive) sees a change.
const STAMP = 'synced_at: ';

const FENCE = '---';

// The lines of a note, the stamp left out. Only inside the front matter, which opens on the first line
// and closes at the next fence: a line of the body that reads the same is what the source said.
const linesWithoutStamp = (text: string): ReadonlyArray<string> => {
  const lines = text.split('\n');
  const close = lines[0] === FENCE ? Math.max(lines.indexOf(FENCE, 1), 0) : 0;
  return [...lines.slice(0, close).filter((line) => !line.startsWith(STAMP)), ...lines.slice(close)];
};

export const sameWrite = (held: string, next: string): boolean => Bun.deepEquals(linesWithoutStamp(held), linesWithoutStamp(next));

export const withLineFeeds = (text: string): string => text.replaceAll(/\r\n?/g, '\n');
