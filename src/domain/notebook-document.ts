import { renderFrontMatter, withFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import type { ListedPage } from './notebook-state.ts';

export type RenderNotebookPageInput = { readonly entry: ListedPage; readonly notebook: string; readonly markdown: string; readonly syncedAt: string };

const stated = (value: string): string | undefined => (value.length > 0 ? value : undefined);

const fieldsOf = (input: RenderNotebookPageInput): ReadonlyArray<FrontMatterField> => [
  ['source', input.entry.page.webUrl.length > 0 ? input.entry.page.webUrl : `OneNote notebook ${input.notebook}`],
  ['notebook', input.notebook],
  ['section', input.entry.section.name],
  ['group', stated(input.entry.section.group)],
  ['title', input.entry.page.title],
  ['created', stated(input.entry.page.created)],
  ['last_modified', stated(input.entry.page.lastModified)],
  ['synced_at', input.syncedAt],
];

// The page's text as the reader handed it over, under a heading of its own; a page that holds
// nothing is headed and no more.
const bodyOf = (input: RenderNotebookPageInput): string => {
  const said = input.markdown.trim();
  return [`# ${input.entry.page.title}`, ...(said.length === 0 ? [] : ['', said])].join('\n');
};

export const renderNotebookPage = (input: RenderNotebookPageInput): string => withFrontMatter(renderFrontMatter(fieldsOf(input)), bodyOf(input));
