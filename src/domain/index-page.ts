import { linkDestination } from './markdown-link.ts';
import { dayIn } from './zoned-day.ts';

export const INDEX_FILE = '_index.md';

// One line of an index: the day it is listed under, the item linked by its title, and the one field a
// reader picks it out by (who sent it, where it stands, who changed it last). A part with nothing in
// it is left out, so a task with no due day reads as its title and its status.
export type IndexRow = { readonly day: string; readonly title: string; readonly file: string; readonly note: string };

export type IndexSection = { readonly heading: string; readonly rows: ReadonlyArray<IndexRow> };

// Link text ends at a line break and is cut short by an unpaired bracket, and a title can hold both.
const linkText = (title: string): string =>
  title
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll(/[[\]]/g, (bracket) => `\\${bracket}`);

const rowLine = (row: IndexRow): string => {
  const text = linkText(row.title);
  const link = `[${text.length > 0 ? text : row.file}](${linkDestination(row.file)})`;
  return `- ${[row.day, link, row.note].filter((part) => part.length > 0).join(' · ')}`;
};

// A file named from the folder the page sits in, which is where a link on the page starts from.
export const relativeTo = (folder: string, file: string): string => (file.startsWith(`${folder}/`) ? file.slice(folder.length + 1) : file);

// The day an instant falls on where the knowledge base counts its days, and nothing for an item that
// gave no instant, rather than a day nobody lived.
export const indexDay = (instantIso: string, zone: string): string => (instantIso.length === 0 ? '' : dayIn(instantIso, zone));

// A page that lists what a source holds, in the order a reader looks for it. It is made from the state
// of the source alone and holds no time stamp, so a run that changed nothing makes the same page, and
// the page on disk stays as it was.
export const renderIndexPage = (title: string, sections: ReadonlyArray<IndexSection>): string => {
  const filled = sections.filter((section) => section.rows.length > 0);
  const body = filled.length === 0 ? ['', 'Nothing here yet.'] : filled.flatMap((section) => ['', `## ${section.heading}`, '', ...section.rows.map(rowLine)]);
  return [`# ${title}`, ...body, ''].join('\n');
};
