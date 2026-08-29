// What an archive holds, as one document a reader opens instead of unzipping. Every member is
// listed with the text read out of it, so an archive of forty photographs reads as a contact sheet:
// the text sits in one place with the rest of the archive around it, rather than scattered across
// forty files that have to be opened one at a time to find which one shows the rack label.
export type ArchiveMember = { readonly path: string; readonly text?: string; readonly note?: string };

// Enough to recognise a member by, not enough to reproduce it. The member's own file holds the rest,
// and a manifest whose lines wrap is no longer a list.
const LINE_LIMIT = 120;

const WHITESPACE = /\s+/g;

const oneLine = (text: string): string => text.replace(WHITESPACE, ' ').trim();

const summaryOf = (member: ArchiveMember): string => {
  const said = oneLine(member.text ?? member.note ?? '');
  if (said.length === 0) return '';
  return said.length <= LINE_LIMIT ? ` — ${said}` : ` — ${said.slice(0, LINE_LIMIT)}…`;
};

const countOf = (members: ReadonlyArray<ArchiveMember>): string => (members.length === 0 ? 'No files.' : `${members.length} files.`);

// The blank line belongs to the list, not to the count: an archive holding nothing would otherwise
// end on a separator with nothing after it.
const listOf = (members: ReadonlyArray<ArchiveMember>): ReadonlyArray<string> =>
  members.length === 0 ? [] : ['', ...members.map((member) => `- ${member.path}${summaryOf(member)}`)];

export const renderZipManifest = (name: string, members: ReadonlyArray<ArchiveMember>): string => [`# ${name}`, '', countOf(members), ...listOf(members), ''].join('\n');
