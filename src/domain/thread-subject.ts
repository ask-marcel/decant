// What a thread is about, with the markers saying how its mail travelled taken off the front.
//
// Three entries of the published list are deliberately absent. `ref` stays because a `REF:` line is
// a reference rather than a reply, and this mailbox uses it that way. The bare letters `r` and `i`
// stay because a one-letter alternative strips real titles: `I: Introduction` is not a forward.
// Adding any of them back should come with the subject that motivated it.
// Longest first, and it must stay that way: `re` placed before `res` would strip the marker and
// leave an `s` where the subject should start. Sorted here rather than at load, so the order is
// visible to whoever adds the next language, and `doorst` appears once.
const MARKERS = [
  'إعادة توجيه',
  'пересылка',
  'antwort',
  'odpověď',
  'doorst',
  'ответ',
  'antw',
  'enc',
  'fwd',
  'ilt',
  'odp',
  'rep',
  'res',
  'rif',
  'rép',
  'ynt',
  'ap',
  'aw',
  'fw',
  'pd',
  'rd',
  're',
  'rv',
  'sv',
  'tr',
  'vb',
  'vl',
  'vs',
  'vá',
  'wg',
  'απ',
  'رد',
  '回复',
  '回覆',
  '答复',
  '転送',
  '轉寄',
  '转发',
  '返信',
  '답장',
  '전달',
  '회신',
];

// Whatever sits between a marker and its colon: a space, a `[2]`, or both. One character class
// rather than two adjacent optional groups, which would make the pattern ambiguous and slow to
// fail. The full-width colon is what CJK clients write, and a pattern knowing only the ASCII one
// leaves the marker in the title of every Chinese thread.
const MARKER_COLON = /^[\s[\]\d]*[:：]\s*/;

// `[EXTERNAL]`, `[FGGC-IT]`: a tag the transport or a mailing list added, not a word anyone wrote.
const LIST_TAG = /^\[[^\]]*\]\s*/;

// Matched against a lowercased copy but cut from the original, so the title keeps its own casing.
// A list of literals rather than one alternation: a pattern this wide is both unreadable and, with
// optional groups around it, a denial of service on a long subject.
const withoutMarker = (subject: string): string | undefined => {
  const marker = MARKERS.find((candidate) => subject.toLowerCase().startsWith(candidate));
  if (marker === undefined) return undefined;
  const rest = subject.slice(marker.length);
  const colon = MARKER_COLON.exec(rest);
  return colon === null ? undefined : rest.slice(colon[0].length);
};

const withoutTag = (subject: string): string | undefined => {
  const tag = LIST_TAG.exec(subject);
  return tag === null ? undefined : subject.slice(tag[0].length);
};

// A real chain interleaves the two, `RE: TR: [EXTERNAL] ...` as readily as `[EXTERNAL] RE: ...`, so
// both come off together until neither is there. Every pass that strips anything consumes at least
// a marker and its colon, so this ends.
export const bareSubject = (subject: string): string => {
  let bare = subject.trim();
  for (;;) {
    const shorter = withoutMarker(bare) ?? withoutTag(bare);
    if (shorter === undefined) return bare;
    bare = shorter;
  }
};
