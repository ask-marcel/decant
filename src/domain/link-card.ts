import { renderFrontMatter } from './front-matter.ts';

// A link is an attachment that happens to live elsewhere, so it gets the same treatment: one
// document per thing the thread pointed at, in the thread's own folder, holding the text the
// document turned out to have and saying where it came from.
//
// The url is what the card is really for. The same document referenced from fifty threads produces
// fifty of these all naming the same address, so the address is what ties them together, and a card
// for something never pulled is the only record that a thread depended on material the knowledge
// base does not hold.
export type LinkCard = {
  readonly threadId: string;
  readonly title: string;
  readonly url: string;
  readonly inMessage: string;
  // When the document last changed at the source, and who changed it. The card stands where the
  // converter's own stamp used to, so it carries the provenance that stamp held or the vault loses
  // it: a thread can then be traced to a version of a document, not merely to its address.
  readonly lastModified?: string;
  readonly modifiedBy?: string;
  // What the document said, read out of it when it was pulled. Carried here rather than linked,
  // because the card and the converter's markdown want the same path and one document per thing is
  // what a reader opening the folder should find.
  readonly body?: string;
  // The document itself, beside this, when a copy of it was kept.
  readonly original?: string;
  readonly note?: string;
};

const DAY_LENGTH = 10;

const pointedAt = (card: LinkCard): string => `Pointed at on ${card.inMessage.slice(0, DAY_LENGTH)}.`;

const bodyOf = (card: LinkCard): string => {
  const pointed = card.body === undefined ? `${pointedAt(card)} ${card.note ?? 'It was not pulled into the knowledge base.'}` : pointedAt(card);
  return card.body === undefined ? pointed : `${pointed}\n\n${card.body}`;
};

export const renderLinkCard = (card: LinkCard): string =>
  [
    renderFrontMatter([
      ['linked_from', card.threadId],
      ['title', card.title],
      ['url', card.url],
      ['in_message', card.inMessage],
      ['last_modified', card.lastModified],
      ['modified_by', card.modifiedBy],
      ['original', card.original],
    ]),
    '',
    `# ${card.title}`,
    '',
    bodyOf(card),
    '',
  ].join('\n');
