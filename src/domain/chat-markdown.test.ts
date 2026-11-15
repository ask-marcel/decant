import { describe, expect, it } from 'bun:test';
import { conversionParts, partMarkdown, withMarkdown } from './chat-markdown.ts';
import { pictureMarker } from './chat-message.ts';
import type { ChatMessage } from './chat-message.ts';

const LIMIT = 500_000;

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: '1794536130123',
  author: 'Jane Doe',
  sent: '2026-11-13T02:15:30.1230000Z',
  text: 'Here is the budget.',
  files: [],
  pictures: 0,
  webUrl: '',
  ...over,
});

describe('the messages of a chat as one document to convert', () => {
  it('the rich messages of a read go into one document, each after its own boundary, and a message typed plain is not in it', () => {
    const parts = conversionParts(['<p>first</p>', undefined, '<p><b>third</b></p>'], LIMIT);

    expect(parts).toEqual([
      {
        html: ['<p>decantmessage0boundary</p>', '<p>first</p>', '<p>decantmessage1boundary</p>', '<p><b>third</b></p>', ''].join('\n'),
        at: [0, 2],
      },
    ]);
    expect(conversionParts([undefined, undefined], LIMIT)).toStrictEqual([]);
  });

  it('a long read is cut into parts below the size limit, counted in bytes, and a message larger than the limit is alone in its part', () => {
    const small = '<p>ab</p>';
    const large = `<p>${'x'.repeat(200)}</p>`;
    const wide = `<p>${'预'.repeat(30)}</p>`;

    const parts = conversionParts([small, small, large, small, wide, small], 100);

    expect(parts.map((part) => part.at)).toEqual([[0, 1], [2], [3], [4], [5]]);
    expect(parts[0]?.html).toBe(['<p>decantmessage0boundary</p>', small, '<p>decantmessage1boundary</p>', small, ''].join('\n'));
    expect(parts[1]?.html).toBe(['<p>decantmessage0boundary</p>', large, ''].join('\n'));
  });

  it('a heading in a message becomes bold text, so it cannot break the outline of the note', () => {
    const parts = conversionParts(['<h2 style="margin:0">Agenda</h2><p>one</p><H1>Top</H1>'], LIMIT);

    expect(parts[0]?.html).toBe(['<p>decantmessage0boundary</p>', '<p><strong>Agenda</strong></p><p>one</p><p><strong>Top</strong></p>', ''].join('\n'));
  });
});

describe('the markdown of a converted document, given back to its messages', () => {
  const part = { html: '', at: [0, 2] };

  it('the markdown is cut at the boundaries, and each message gets its part with no space around it', () => {
    const markdown = [
      'decantmessage0boundary',
      '',
      '> **Jane Doe**',
      '> ',
      '> Can you send it?',
      '',
      'Yes, **here**.',
      '',
      'decantmessage1boundary  ',
      '',
      '| Port | ETA |',
      '| --- | --- |',
      '',
    ].join('\n');

    expect(partMarkdown(part, markdown)).toEqual([['> **Jane Doe**', '> ', '> Can you send it?', '', 'Yes, **here**.'].join('\n'), ['| Port | ETA |', '| --- | --- |'].join('\n')]);
  });

  it('a markdown answer with a boundary missing, added, out of order, or with words before the first one gives nothing, so the plain text stays', () => {
    expect(partMarkdown(part, 'decantmessage0boundary\n\nonly one')).toBeUndefined();
    expect(partMarkdown(part, 'decantmessage0boundary\n\na\n\ndecantmessage1boundary\n\nb\n\ndecantmessage2boundary\n\nc')).toBeUndefined();
    expect(partMarkdown(part, 'decantmessage1boundary\n\na\n\ndecantmessage0boundary\n\nb')).toBeUndefined();
    expect(partMarkdown(part, 'stray\n\ndecantmessage0boundary\n\na\n\ndecantmessage1boundary\n\nb')).toBeUndefined();
    expect(partMarkdown(part, '')).toBeUndefined();
  });

  it('a boundary inside a line of a message is not a boundary', () => {
    expect(partMarkdown({ html: '', at: [0] }, 'decantmessage0boundary\n\nsee decantmessage1boundary here')).toEqual(['see decantmessage1boundary here']);
  });

  it('a picture marker comes back without the backslashes the converter put on it', () => {
    const markdown = ['decantmessage0boundary', '', String.raw`Look \[\[picture 1\]\] and \[\[picture 12\]\], not \[this\].`].join('\n');

    expect(partMarkdown({ html: '', at: [0] }, markdown)).toEqual([String.raw`Look ${pictureMarker(0)} and ${pictureMarker(11)}, not \[this\].`]);
  });

  it('a message takes its markdown as its words, and one with no markdown, or an empty one, keeps the words it had', () => {
    expect(withMarkdown(message(), 'Here is the **budget**.')).toEqual(message({ text: 'Here is the **budget**.' }));
    expect(withMarkdown(message(), undefined)).toEqual(message());
    expect(withMarkdown(message(), '')).toEqual(message());
  });
});
