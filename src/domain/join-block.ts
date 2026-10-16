// The block a meeting invitation carries to say how to join it: Teams writes it between two rules of
// underscores, Google Meet between two rules of `-::~:~::`, and Zoom from "Join Zoom Meeting" to the
// line that sends a reader to the local numbers, with the ways to join by SIP or H.323 after it. It is
// the same dozen lines in every invitation (a link to join, a meeting ID and a passcode, dial-in
// numbers, help, meeting options) and says nothing a reader of the meeting looks for. The link to
// join can stand in its place.

// A rule of underscores, each escaped in the markdown a mail's body is, and Meet's rule, whose first
// dash that markdown escapes too, since a dash that opens a line would make a list.
const TEAMS_RULE = /^\s*(?:\\?_){10,}\s*$/;
const MEET_RULE = /^\s*\\?-[:~]{10,}-\s*$/;
const ZOOM_OPENS = /^\W*Join Zoom Meeting\W*$/i;
const ZOOM_ENDS = /^\W*Find your local number/i;
// Where a block says to join: a Teams link in its long form and in the short one Teams writes since
// 2026, the short one of Teams for personal use, a Meet link and a Zoom link.
const JOIN_AT = /https:\/\/(?:teams\.microsoft\.com\/(?:l\/meetup-join|meet)|teams\.live\.com\/meet|meet\.google\.com|[a-z0-9.-]*zoom\.us\/j)\/[^\s)<>\]]*/i;
// A markdown link is read as where it goes, not as its text: a mail's markdown escapes each underscore
// of a link's text, and the short Teams link is its own text.
// `[^[\]]` rather than `[^\]]`, so a run of `[` with no `]` fails at each one instead of rescanning to the
// end from every one, and the same for `(`.
const MARKDOWN_LINK = /\[[^[\]]*\]\(([^()]*)\)/g;
// Taking lines out leaves the blank lines around them side by side.
const WIDENED = /\n{3,}/g;

// What tells a join block from words a sender put between two rules: a link to join, or a line that
// opens with the meeting's ID.
const MEETING_ID = /^\W*(?:Meeting|Conference) ID:/i;

type Span = { readonly from: number; readonly to: number };

const isJoinBlock = (lines: ReadonlyArray<string>): boolean => lines.some((line) => JOIN_AT.test(line) || MEETING_ID.test(line));

// Teams puts a shorter rule inside its block, before the dial-in numbers, and a reply quoted under a
// mail can open with one, so only a rule of the same text as the one that opened a block closes it.
const ruledSpan = (lines: ReadonlyArray<string>, at: number): Span | undefined => {
  const rule = (lines[at] ?? '').trim();
  const to = lines.findIndex((line, index) => index > at && line.trim() === rule);
  return to > at && isJoinBlock(lines.slice(at + 1, to)) ? { from: at, to } : undefined;
};

// Past the local numbers Zoom can add ways to join by SIP, by H.323 and by Skype for Business: each a
// heading and its addresses, with the meeting ID and the passcode again, between rules of dashes.
// Only lines of that form are taken, so a line a sender wrote after them stays.
const JOIN_BY = /^\W*Join by (?:SIP|H\.323|Skype for Business)\W*$/i;
// A blank line or a rule: no letter and no digit, in any script.
const BLANKISH = /^[^\p{L}\p{N}]*$/u;
const ZOOM_TAIL: ReadonlyArray<RegExp> = [
  BLANKISH,
  JOIN_BY,
  /^\W*(?:Meeting ID|Passcode|Password)\W*:/i,
  // An H.323 address, with the place it serves.
  /^\W*\d{1,3}(?:\.\d{1,3}){3}(?: \([^()]*\))?\W*$/,
  // A SIP address, or the link to join from Skype for Business.
  /^\W*(?:\d+@(?:sip\.)?zoom(?:crc|gov)?\.com|https:\/\/[a-z0-9.-]*zoom(?:gov)?\.(?:us|com)\/skype\/)/i,
];

const isZoomTail = (line: string): boolean => ZOOM_TAIL.some((pattern) => pattern.test(line));

// The last line of what follows the local numbers when the first of it is a way to join by SIP, H.323
// or Skype, else the line of the local numbers: a passcode a sender wrote after them stays.
const zoomTailEnd = (lines: ReadonlyArray<string>, end: number): number => {
  const after = lines.slice(end + 1);
  const stop = after.findIndex((line) => !isZoomTail(line));
  const run = stop === -1 ? after : after.slice(0, stop);
  const first = run.find((line) => !BLANKISH.test(line));
  return first !== undefined && JOIN_BY.test(first) ? end + 1 + run.findLastIndex((line) => !BLANKISH.test(line)) : end;
};

// A second invitation that opens first means this one never reached its local numbers.
const zoomSpan = (lines: ReadonlyArray<string>, at: number): Span | undefined => {
  const to = lines.findIndex((line, index) => index > at && (ZOOM_ENDS.test(line) || ZOOM_OPENS.test(line)));
  return to > at && ZOOM_ENDS.test(lines[to] ?? '') ? { from: at, to: zoomTailEnd(lines, to) } : undefined;
};

// A block that opens at this line and closes, or none: a rule never closed, or rules around anything
// else, is content.
const spanAt = (lines: ReadonlyArray<string>, at: number): Span | undefined => {
  const line = lines[at] ?? '';
  if (TEAMS_RULE.test(line) || MEET_RULE.test(line)) return ruledSpan(lines, at);
  return ZOOM_OPENS.test(line) ? zoomSpan(lines, at) : undefined;
};

// The line a join block leaves where nothing else holds its link to join.
export const joinLine = (joinUrl: string): string => `Online meeting: ${joinUrl}`;

const joinUrlOf = (block: string): string | undefined => JOIN_AT.exec(block.replace(MARKDOWN_LINK, '$1'))?.[0];

// What a block leaves: nothing, or the line `standIn` makes of its link to join, unless it makes an
// empty one, for a link held elsewhere. Asked for that line with no link it knows, the block stays as
// it was (undefined): a link this code does not know is still the way into the meeting.
const leftOf = (block: ReadonlyArray<string>, standIn: ((joinUrl: string) => string) | undefined): ReadonlyArray<string> | undefined => {
  if (standIn === undefined) return [];
  const joinUrl = joinUrlOf(block.join('\n'));
  return joinUrl === undefined ? undefined : [standIn(joinUrl)].filter((line) => line.length > 0);
};

// The text with each join block taken out, and in its place the line `standIn` makes of its link to
// join, when it is given one and makes one. Text with no block taken out comes back as it was.
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
    const block = lines.slice(span.from, span.to + 1);
    const left = leftOf(block, standIn);
    found ||= left !== undefined;
    kept.push(...(left ?? block));
    at = span.to + 1;
  }
  return found ? kept.join('\n').replace(WIDENED, '\n\n') : text;
};
