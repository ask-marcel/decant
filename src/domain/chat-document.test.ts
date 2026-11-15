import { describe, expect, it } from 'bun:test';
import { byDay, renderDayNote } from './chat-document.ts';
import type { DayNoteInput, NotedMessage } from './chat-document.ts';
import { pictureMarker } from './chat-message.ts';
import type { ChatMessage } from './chat-message.ts';

const ZONE = 'Asia/Shanghai';

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: '1794536130123',
  author: 'Jane Doe',
  sent: '2026-11-13T02:15:30.1230000Z',
  text: 'Here is the budget.',
  files: [],
  pictures: 0,
  webUrl: 'https://teams.microsoft.com/l/message/19%3Aabc%40thread.v2/1794536130123',
  ...over,
});

const noted = (over: Partial<ChatMessage> = {}, rest: Partial<Omit<NotedMessage, 'message'>> = {}): NotedMessage => ({ message: message(over), pictures: [], files: [], ...rest });

const note = (over: Partial<DayNoteInput> = {}): DayNoteInput => ({
  chat: 'Budget review',
  kind: 'group',
  members: ['Jane Doe', 'Li Wei'],
  day: '2026-11-13',
  zone: ZONE,
  messages: [noted()],
  syncedAt: '2026-11-14T01:00:00.000Z',
  ...over,
});

describe('one day of a chat as a note', () => {
  it('says which chat and who is in it, then gives each message under its hour and its writer, with its file and its picture', () => {
    const second = noted(
      { id: '1794536430123', author: 'Li Wei', sent: '2026-11-13T02:20:30.1230000Z', text: `Look: ${pictureMarker(0)}`, pictures: 1, webUrl: '' },
      { pictures: [{ link: '2026-11-13/_inline/1794536430123-1.png', text: 'Total 42\n\nMargin 7' }] }
    );
    const first = noted({}, { files: [{ name: 'Budget.xlsx', link: '2026-11-13/_linked/Budget.xlsx.md' }] });

    expect(renderDayNote(note({ messages: [first, second] }))).toBe(
      [
        '---',
        'source: https://teams.microsoft.com/l/message/19%3Aabc%40thread.v2/1794536130123',
        'chat: Budget review',
        'kind: group',
        'members:',
        '  - Jane Doe',
        '  - Li Wei',
        'day: "2026-11-13"',
        'messages: 2',
        'synced_at: "2026-11-14T01:00:00.000Z"',
        '---',
        '',
        '# Budget review, 2026-11-13',
        '',
        '### 10:15 · Jane Doe',
        '',
        'Here is the budget.',
        '',
        '- [Budget.xlsx](2026-11-13/_linked/Budget.xlsx.md)',
        '',
        '### 10:20 · Li Wei',
        '',
        'Look: ![picture](2026-11-13/_inline/1794536430123-1.png)',
        '',
        'Text in picture 1:',
        '',
        '> Total 42',
        '>',
        '> Margin 7',
        '',
      ].join('\n')
    );
  });

  it('a chat between two people, or of a meeting, says so, and a day whose messages carry no link says where it came from in words', () => {
    const oneOnOne = renderDayNote(note({ kind: 'oneOnOne', members: ['Jane Doe'], messages: [noted({ webUrl: '' })] }));
    const meeting = renderDayNote(note({ kind: 'meeting' }));

    expect(oneOnOne).toContain('source: Teams chat\n');
    expect(oneOnOne).toContain('kind: one-to-one\n');
    expect(meeting).toContain('kind: meeting\n');
  });

  it('a file that did not arrive is named under its message with the reason, linked to its card when it has one', () => {
    const files = [
      { name: 'Notes.docx', note: 'permanent: 403 Forbidden' },
      { name: 'Plan [v2] (final).pptx', link: '2026-11-13/_linked/Plan [v2] (final).pptx.md', note: 'larger than the 50 MB cap' },
    ];

    const rendered = renderDayNote(note({ messages: [noted({ text: '' }, { files })] }));

    expect(rendered).toContain(
      [
        '### 10:15 · Jane Doe',
        '',
        '- Notes.docx: permanent: 403 Forbidden',
        '- [Plan \\[v2\\] (final).pptx](<2026-11-13/_linked/Plan [v2] (final).pptx.md>): larger than the 50 MB cap',
        '',
      ].join('\n')
    );
  });

  it('a picture that could not be saved says so in its place, each time the message shows it, and one OCR read nothing in has no reading', () => {
    const text = `${pictureMarker(0)} then ${pictureMarker(1)} and ${pictureMarker(0)} again`;

    const rendered = renderDayNote(note({ messages: [noted({ text, pictures: 2 }, { pictures: [undefined, { link: 'a b.png', text: '' }] })] }));

    expect(rendered).toContain('\\[picture not saved\\] then ![picture](<a b.png>) and \\[picture not saved\\] again\n');
    expect(rendered).not.toContain('Text in picture');
  });

  it('a message that carried no time is filed at an hour nobody lived, not left out', () => {
    expect(renderDayNote(note({ messages: [noted({ sent: '' })] }))).toContain('### 00:00 · Jane Doe\n');
  });
});

describe('sorting the messages of a chat into days', () => {
  it('a message written at 23:30 UTC belongs to the next day where the knowledge base counts in Asia/Shanghai', () => {
    const late = message({ id: '2', sent: '2026-11-13T23:30:00.0000000Z' });
    const early = message({ id: '1', sent: '2026-11-13T02:00:00.0000000Z' });

    expect(byDay([late, early], ZONE)).toEqual([
      { day: '2026-11-13', messages: [early] },
      { day: '2026-11-14', messages: [late] },
    ]);
    expect(byDay([late, early], 'UTC')).toEqual([{ day: '2026-11-13', messages: [early, late] }]);
  });

  it('a day reads in the order the messages were written, two of one instant in the order of their ids, whatever order they were read in', () => {
    const third = message({ id: 'c', sent: '2026-11-13T03:00:00.0000000Z' });
    const second = message({ id: 'b', sent: '2026-11-13T02:00:00.0000000Z' });
    const first = message({ id: 'a', sent: '2026-11-13T02:00:00.0000000Z' });

    expect(byDay([third, second, first], ZONE)[0]?.messages.map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  it('a message read twice is kept once, as it was read last', () => {
    const before = message({ id: 'a', text: 'draft' });
    const after = message({ id: 'a', text: 'final' });

    expect(byDay([before, after], ZONE)).toEqual([{ day: '2026-11-13', messages: [after] }]);
  });
});

describe('a message that arrived as markdown', () => {
  it('a quote, a table and a code block are written as they are under the heading of the message, and a picture marker inside them becomes the link of the picture', () => {
    const text = [
      '> **Li Wei**',
      '> ',
      '> Can you send the budget?',
      '',
      `Yes: ${pictureMarker(0)}`,
      '',
      '| Port | ETA |',
      '| --- | --- |',
      `| Ningbo | ${pictureMarker(0)} |`,
      '',
      '```sql',
      'select * from t_orders;',
      '```',
    ].join('\n');
    const rich = noted({ text, pictures: 1 }, { pictures: [{ link: '2026-11-13/_inline/1794536130123-1.png' }] });

    const body = renderDayNote(note({ messages: [rich] })).split('### 10:15 · Jane Doe\n\n')[1];

    expect(body).toBe(
      [
        '> **Li Wei**',
        '> ',
        '> Can you send the budget?',
        '',
        'Yes: ![picture](2026-11-13/_inline/1794536130123-1.png)',
        '',
        '| Port | ETA |',
        '| --- | --- |',
        '| Ningbo | ![picture](2026-11-13/_inline/1794536130123-1.png) |',
        '',
        '```sql',
        'select * from t_orders;',
        '```',
        '',
      ].join('\n')
    );
  });
});
