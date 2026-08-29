import { renderFrontMatter } from './front-matter.ts';

// A link is an attachment that happens to live elsewhere, so it gets the same treatment: one card
// per referenced document, beside the thread that referenced it, pointing at a copy held once.
//
// The url is what the card is really for. The same document referenced from fifty threads produces
// fifty small cards all naming the same address, so the address is what ties them together, and a
// card for something never pulled is the only record that a thread depended on material the
// knowledge base does not hold.
export type LinkCard = {
  readonly threadId: string;
  readonly title: string;
  readonly url: string;
  readonly inMessage: string;
  readonly holds?: string;
  readonly note?: string;
};

const DAY_LENGTH = 10;

const bodyOf = (card: LinkCard): string => {
  const pointed = `Pointed at on ${card.inMessage.slice(0, DAY_LENGTH)}`;
  if (card.holds === undefined) return `${pointed}. ${card.note ?? 'It was not pulled into the knowledge base.'}`;
  return `${pointed}, and pulled into [the shared store](${card.holds}),\nwhere it is held once however many threads pointed at it.`;
};

export const renderLinkCard = (card: LinkCard): string =>
  [
    renderFrontMatter([
      ['linked_from', card.threadId],
      ['title', card.title],
      ['url', card.url],
      ['in_message', card.inMessage],
      ['holds', card.holds],
    ]),
    '',
    `# ${card.title}`,
    '',
    bodyOf(card),
    '',
  ].join('\n');
