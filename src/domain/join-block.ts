// The block a meeting invitation carries to say how to join it: Teams writes it between two rules of
// underscores, Google Meet between two rules of `-::~:~::`, and Zoom from "Join Zoom Meeting" to the
// line that sends a reader to the local numbers. It is the same dozen lines in every invitation (a
// link to join, a meeting ID and a passcode, dial-in numbers, help, meeting options) and says nothing
// a reader of the meeting looks for. The link to join can stand in its place.

// A rule of underscores, each escaped in the markdown a mail's body is.
const TEAMS_RULE = /^\s*(?:\\?_){10,}\s*$/;
const MEET_RULE = /^\s*-[:~]{10,}-\s*$/;
const ZOOM_OPENS = /^\W*Join Zoom Meeting\W*$/i;
const ZOOM_ENDS = /^\W*Find your local number/i;
// What only a join block holds, so that words a sender put between two rules are not taken for one.
const JOINS = /teams\.microsoft\.com\/l\/meetup-join|Microsoft Teams|meet\.google\.com|Meeting ID|Conference ID/i;
const JOIN_AT = /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join|meet\.google\.com|[a-z0-9.-]*zoom\.us\/j)\/[^\s)<>\]]*/i;
// Taking lines out leaves the blank lines around them side by side.
const WIDENED = /\n{3,}/g;

type Span = { readonly from: number; readonly to: number };

// The first line after `from` that closes what opened there, or -1.
const closing = (lines: ReadonlyArray<string>, from: number, closes: RegExp): number => lines.findIndex((line, index) => index > from && closes.test(line));

const ruledSpan = (lines: ReadonlyArray<string>, at: number, rule: RegExp): Span | undefined => {
  const to = closing(lines, at, rule);
  return to > at && JOINS.test(lines.slice(at, to).join('\n')) ? { from: at, to } : undefined;
};

// A block that opens at this line and closes, or none: a rule never closed, or rules around anything
// else, is content.
const spanAt = (lines: ReadonlyArray<string>, at: number): Span | undefined => {
  const line = lines[at] ?? '';
  const rule = [TEAMS_RULE, MEET_RULE].find((candidate) => candidate.test(line));
  if (rule !== undefined) return ruledSpan(lines, at, rule);
  if (!ZOOM_OPENS.test(line)) return undefined;
  const to = closing(lines, at, ZOOM_ENDS);
  return to > at ? { from: at, to } : undefined;
};

// The text with each join block taken out, and in its place the line `standIn` makes of the link to
// join, when it is given one and the block holds one. Text with no block comes back as it was.
export const withoutJoinBlocks = (text: string, standIn?: (joinUrl: string) => string): string => {
  const lines = text.split('\n');
  const kept: string[] = [];
  let found = false;
  let at = 0;
  while (at < lines.length) {
    const span = spanAt(lines, at);
    if (span === undefined) {
      kept.push(lines[at] ?? '');
      at += 1;
      continue;
    }
    found = true;
    const joinUrl = JOIN_AT.exec(lines.slice(span.from, span.to + 1).join('\n'))?.[0];
    if (joinUrl !== undefined && standIn !== undefined) kept.push(standIn(joinUrl));
    at = span.to + 1;
  }
  return found ? kept.join('\n').replace(WIDENED, '\n\n') : text;
};
