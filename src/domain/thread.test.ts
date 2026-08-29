import { describe, expect, it } from 'bun:test';
import type { MailMessage } from './mail-message.ts';
import { participantsOf, renderThread, threadTitle, withoutMailHeaders } from './thread.ts';

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'm1',
  conversationId: 'AAQkADk0...=',
  subject: 'Contrat Contoso',
  received: '2026-05-12T09:31:00Z',
  hasAttachments: false,
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [{ name: 'Vincent DELACOURT', address: 'vincent@example.com' }],
  isDeleted: false,
  ...over,
});

describe('reading the subject a thread is known by', () => {
  it('a reply keeps the thread under the subject it started with', () => {
    expect(threadTitle('RE: RE: Contrat Contoso')).toBe(threadTitle('Contrat Contoso'));
  });

  it('forwards and French replies are stripped the same way', () => {
    expect(threadTitle('FW: Contrat')).toBe('Contrat');
    expect(threadTitle('TR: Contrat')).toBe('Contrat');
    expect(threadTitle('RE: FW: Contrat')).toBe('Contrat');
    expect(threadTitle('RE[2]: Contrat')).toBe('Contrat');
    expect(threadTitle('RE [2] : Contrat')).toBe('Contrat');
    expect(threadTitle('RE:Contrat')).toBe('Contrat');
  });

  // The heading and the folder name strip the same markers, so a thread cannot read one way in the
  // document and another in the path it sits at.
  it('a marker only the folder name used to know is stripped from the heading too', () => {
    expect(threadTitle('回复: Kick-off')).toBe('Kick-off');
    expect(threadTitle('[EXTERNAL] Kick-off')).toBe('Kick-off');
  });

  it('a subject padded with spaces is trimmed, before and after its reply markers are stripped', () => {
    expect(threadTitle('   Contrat   ')).toBe('Contrat');
    expect(threadTitle('  RE:   Contrat  ')).toBe('Contrat');
  });

  it('a subject that merely contains a marker keeps it, since only a prefix says how mail travelled', () => {
    expect(threadTitle('Contrat re: signature')).toBe('Contrat re: signature');
    expect(threadTitle('REF: Contrat')).toBe('REF: Contrat');
  });

  it('a thread with no subject at all still reads as having one', () => {
    expect(threadTitle('RE:')).toBe('No subject');
    expect(threadTitle('   ')).toBe('No subject');
  });
});

describe('writing a conversation as one document', () => {
  it('the whole thread is one file, oldest message first, each under who wrote it and when', () => {
    const parts = [
      {
        message: message({
          id: 'm2',
          received: '2026-05-13T10:00:00Z',
          from: { name: 'Vincent DELACOURT', address: 'v@example.com' },
          to: [{ name: 'Jane Doe', address: 'j@example.com' }],
        }),
        body: 'Agreed.',
      },
      { message: message({ id: 'm1' }), body: 'Here is the contract.' },
    ];

    expect(renderThread({ subject: 'RE: Contrat Contoso', parts })).toBe(
      [
        '# Contrat Contoso',
        '',
        '## 2026-05-12 09:31 — Jane Doe to Vincent DELACOURT',
        '',
        'Here is the contract.',
        '',
        '## 2026-05-13 10:00 — Vincent DELACOURT to Jane Doe',
        '',
        'Agreed.',
      ].join('\n')
    );
  });

  it('a message I sent appears in the thread beside the ones I received', () => {
    const parts = [
      { message: message({ id: 'in', received: '2026-05-12T09:31:00Z' }), body: 'Could you confirm?' },
      {
        message: message({
          id: 'out',
          received: '2026-05-12T11:00:00Z',
          from: { name: 'Vincent DELACOURT', address: 'vincent@example.com' },
          to: [{ name: 'Jane Doe', address: 'jane@example.com' }],
        }),
        body: 'Confirmed, signing today.',
      },
    ];

    const rendered = renderThread({ subject: 'Contrat Contoso', parts });

    expect(rendered).toContain('## 2026-05-12 11:00 — Vincent DELACOURT to Jane Doe');
    expect(rendered).toContain('Confirmed, signing today.');
  });

  it('a message written to nobody in particular names no recipients', () => {
    const rendered = renderThread({ subject: 'Contrat', parts: [{ message: message({ from: undefined, to: [] }), body: 'Body.' }] });

    expect(rendered).toBe(['# Contrat', '', '## 2026-05-12 09:31 — Unknown sender', '', 'Body.'].join('\n'));
  });

  it('a message written to several people names them all', () => {
    const to = [
      { name: 'Jane Doe', address: 'j@example.com' },
      { name: 'David Chang', address: 'd@example.com' },
    ];
    const rendered = renderThread({ subject: 'Contrat', parts: [{ message: message({ to }), body: 'Body.' }] });

    expect(rendered).toContain('— Jane Doe to Jane Doe, David Chang');
  });

  it('the header block the converter adds is dropped, since the section already says all of it', () => {
    const body = ['**Subject:** FW: Kick-off', '**From:** Eva Xie <eva@example.com>', '**To:** Vincent DELACOURT', '**Date:** 2026-07-08', '', 'Please review the budget.'].join(
      '\n'
    );
    const rendered = renderThread({ subject: 'Kick-off', parts: [{ message: message({ from: undefined, to: [] }), body }] });

    expect(rendered).toBe(['# Kick-off', '', '## 2026-05-12 09:31 — Unknown sender', '', 'Please review the budget.'].join('\n'));
  });

  it('a message that is nothing but its header block reads as having no body', () => {
    const body = '**Subject:** Kick-off\n**From:** Eva Xie';
    const rendered = renderThread({ subject: 'Kick-off', parts: [{ message: message(), body }] });

    expect(rendered).toContain('_This message had no readable body._');
  });

  it('a first line that mentions a header field mid-sentence is kept, since only a line opening with one is a header', () => {
    const body = 'Please check the **Subject:** field before sending.\n\nThe rest follows.';
    const rendered = renderThread({ subject: 'Kick-off', parts: [{ message: message(), body }] });

    expect(rendered).toContain('Please check the **Subject:** field before sending.');
  });

  it('a body that merely mentions those words keeps them, since only a leading block is a header', () => {
    const body = 'As agreed:\n\n**Subject:** is the wrong word here.';
    const rendered = renderThread({ subject: 'Kick-off', parts: [{ message: message(), body }] });

    expect(rendered).toContain('As agreed:');
    expect(rendered).toContain('**Subject:** is the wrong word here.');
  });

  it('a message that converted to nothing says so rather than leaving a gap', () => {
    const rendered = renderThread({ subject: 'Contrat', parts: [{ message: message(), body: '   ' }] });

    expect(rendered).toContain('_This message had no readable body._');
  });

  it('padding around a message body is trimmed away, so sections read evenly', () => {
    const rendered = renderThread({ subject: 'Contrat', parts: [{ message: message({ from: undefined, to: [] }), body: '\n\n  Body.  \n\n' }] });

    expect(rendered).toBe(['# Contrat', '', '## 2026-05-12 09:31 — Unknown sender', '', 'Body.'].join('\n'));
  });

  it('an empty conversation still produces its title', () => {
    expect(renderThread({ subject: 'Contrat', parts: [] })).toBe('# Contrat');
  });

  it('messages handed over in any order are written oldest first', () => {
    const at = (id: string, day: string): { message: MailMessage; body: string } => ({
      message: message({ id, received: `2026-05-${day}T09:00:00Z`, from: undefined, to: [] }),
      body: id,
    });

    expect(renderThread({ subject: 'Contrat', parts: [at('m2', '13'), at('m3', '14'), at('m1', '12')] })).toBe(
      [
        '# Contrat',
        '',
        '## 2026-05-12 09:00 — Unknown sender',
        '',
        'm1',
        '',
        '## 2026-05-13 09:00 — Unknown sender',
        '',
        'm2',
        '',
        '## 2026-05-14 09:00 — Unknown sender',
        '',
        'm3',
      ].join('\n')
    );
  });
});

// Reached directly rather than through `renderThread`, whose body trimming hides every difference
// this function makes to the lines it drops.
describe('finding where a message actually starts', () => {
  it('blank lines before the first words are dropped, so a section opens on the text', () => {
    expect(withoutMailHeaders('\n\nPlease review the budget.')).toBe('Please review the budget.');
  });

  it('a message that opens on its text keeps every line of it', () => {
    expect(withoutMailHeaders('Please review the budget.\nIt is attached.')).toBe('Please review the budget.\nIt is attached.');
  });

  it('a line of nothing but spaces counts as blank, since it is what a converter leaves behind', () => {
    expect(withoutMailHeaders('   \n\t\nPlease review the budget.')).toBe('Please review the budget.');
  });
});

describe('listing who took part in a conversation', () => {
  it('everyone who wrote or received is named once, in a stable order', () => {
    const parts = [
      { message: message(), body: '' },
      { message: message({ id: 'm2', from: { name: 'Vincent DELACOURT', address: 'v@example.com' }, to: [{ name: 'Jane Doe', address: 'j@example.com' }] }), body: '' },
    ];

    expect(participantsOf(parts)).toEqual(['Jane Doe', 'Vincent DELACOURT']);
  });

  // The length is pinned beside the contents: an array holding one `undefined` satisfies `toEqual([])`
  // in Bun, so a sender that leaked through as nothing would read as nobody having been named.
  it('a conversation with nobody named lists nobody', () => {
    const named = participantsOf([{ message: message({ from: undefined, to: [] }), body: '' }]);

    expect(named).toEqual([]);
    expect(named).toHaveLength(0);
  });

  it('the names are sorted, so the same people read the same way whatever order they wrote in', () => {
    const parts = [
      { message: message({ from: { name: 'Zoe Wang', address: 'z@example.com' }, to: [{ name: 'Adam Bell', address: 'a@example.com' }] }), body: '' },
      { message: message({ id: 'm2', from: { name: 'Marc Petit', address: 'm@example.com' }, to: [] }), body: '' },
    ];

    expect(participantsOf(parts)).toEqual(['Adam Bell', 'Marc Petit', 'Zoe Wang']);
  });

  it('a message with no sender still counts the people it was written to', () => {
    const parts = [{ message: message({ from: undefined, to: [{ name: 'Jane Doe', address: 'j@example.com' }] }), body: '' }];
    const named = participantsOf(parts);

    expect(named).toEqual(['Jane Doe']);
    expect(named).toHaveLength(1);
  });
});
