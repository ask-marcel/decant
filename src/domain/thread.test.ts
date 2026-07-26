import { describe, expect, it } from 'bun:test';
import type { MailMessage } from './mail-message.ts';
import { participantsOf, renderThread, shortHash, threadFileName, threadTitle, threadYear } from './thread.ts';

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

describe('naming the file a conversation lives in', () => {
  it('the name is the day it started, its subject and a fingerprint of the thread', () => {
    expect(threadFileName({ conversationId: 'AAQkADk0...=', subject: 'Contrat Contoso', firstReceived: '2026-05-12T09:31:00Z' })).toBe(
      `2026-05-12 Contrat Contoso ${shortHash('AAQkADk0...=')}.md`
    );
  });

  it('a reply keeps the thread under its original subject, so the file never renames', () => {
    const started = { conversationId: 'c1', subject: 'Contrat Contoso', firstReceived: '2026-05-12T09:31:00Z' };
    const replied = { conversationId: 'c1', subject: 'RE: RE: Contrat Contoso', firstReceived: '2026-05-12T09:31:00Z' };

    expect(threadFileName(replied)).toBe(threadFileName(started));
  });

  it('forwards and French replies are stripped the same way', () => {
    expect(threadTitle('FW: Contrat')).toBe('Contrat');
    expect(threadTitle('TR: Contrat')).toBe('Contrat');
    expect(threadTitle('RE: FW: Contrat')).toBe('Contrat');
    expect(threadTitle('RE[2]: Contrat')).toBe('Contrat');
    expect(threadTitle('RE [2] : Contrat')).toBe('Contrat');
    expect(threadTitle('RE:Contrat')).toBe('Contrat');
  });

  it('a subject that merely contains a marker keeps it, since only a prefix says how mail travelled', () => {
    expect(threadTitle('Contrat re: signature')).toBe('Contrat re: signature');
    expect(threadTitle('REF: Contrat')).toBe('REF: Contrat');
  });

  it('every conversation fingerprints to the same width, however short its hash', () => {
    expect(shortHash('conv-138')).toBe('0ec399');
    expect(shortHash('conv-138')).toHaveLength(6);
  });

  it('a thread with no subject at all still gets a readable name', () => {
    expect(threadFileName({ conversationId: 'c1', subject: '   ', firstReceived: '2026-05-12T09:31:00Z' })).toContain('No subject');
    expect(threadTitle('RE:')).toBe('No subject');
  });

  it('a subject the filesystem cannot hold is made safe', () => {
    expect(threadFileName({ conversationId: 'c1', subject: 'Q1/Q2: budget', firstReceived: '2026-05-12T09:31:00Z' })).toContain('Q1_Q2_ budget');
  });

  it('a very long subject is shortened so the path stays writable', () => {
    const name = threadFileName({ conversationId: 'c1', subject: 'a'.repeat(300), firstReceived: '2026-05-12T09:31:00Z' });

    expect(name.length).toBeLessThan(110);
  });

  it('two different threads sharing a day and a subject still get their own file', () => {
    const first = threadFileName({ conversationId: 'c1', subject: 'Contrat', firstReceived: '2026-05-12T09:31:00Z' });
    const second = threadFileName({ conversationId: 'c2', subject: 'Contrat', firstReceived: '2026-05-12T09:31:00Z' });

    expect(first).not.toBe(second);
  });

  it('the same conversation always fingerprints the same way, run after run', () => {
    expect(shortHash('AAQkADk0...=')).toBe(shortHash('AAQkADk0...='));
    expect(shortHash('AAQkADk0...=')).toHaveLength(6);
  });

  it('threads are filed by the year they started', () => {
    expect(threadYear('2026-05-12T09:31:00Z')).toBe('2026');
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

    expect(renderThread({ conversationId: 'c1', subject: 'RE: Contrat Contoso', parts })).toBe(
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

    const rendered = renderThread({ conversationId: 'c1', subject: 'Contrat Contoso', parts });

    expect(rendered).toContain('## 2026-05-12 11:00 — Vincent DELACOURT to Jane Doe');
    expect(rendered).toContain('Confirmed, signing today.');
  });

  it('a message written to nobody in particular names no recipients', () => {
    const rendered = renderThread({ conversationId: 'c1', subject: 'Contrat', parts: [{ message: message({ from: undefined, to: [] }), body: 'Body.' }] });

    expect(rendered).toBe(['# Contrat', '', '## 2026-05-12 09:31 — Unknown sender', '', 'Body.'].join('\n'));
  });

  it('a message written to several people names them all', () => {
    const to = [
      { name: 'Jane Doe', address: 'j@example.com' },
      { name: 'David Chang', address: 'd@example.com' },
    ];
    const rendered = renderThread({ conversationId: 'c1', subject: 'Contrat', parts: [{ message: message({ to }), body: 'Body.' }] });

    expect(rendered).toContain('— Jane Doe to Jane Doe, David Chang');
  });

  it('the header block the converter adds is dropped, since the section already says all of it', () => {
    const body = ['**Subject:** FW: Kick-off', '**From:** Eva Xie <eva@example.com>', '**To:** Vincent DELACOURT', '**Date:** 2026-07-08', '', 'Please review the budget.'].join(
      '\n'
    );
    const rendered = renderThread({ conversationId: 'c1', subject: 'Kick-off', parts: [{ message: message({ from: undefined, to: [] }), body }] });

    expect(rendered).toBe(['# Kick-off', '', '## 2026-05-12 09:31 — Unknown sender', '', 'Please review the budget.'].join('\n'));
  });

  it('a message that is nothing but its header block reads as having no body', () => {
    const body = '**Subject:** Kick-off\n**From:** Eva Xie';
    const rendered = renderThread({ conversationId: 'c1', subject: 'Kick-off', parts: [{ message: message(), body }] });

    expect(rendered).toContain('_This message had no readable body._');
  });

  it('a body that merely mentions those words keeps them, since only a leading block is a header', () => {
    const body = 'As agreed:\n\n**Subject:** is the wrong word here.';
    const rendered = renderThread({ conversationId: 'c1', subject: 'Kick-off', parts: [{ message: message(), body }] });

    expect(rendered).toContain('As agreed:');
    expect(rendered).toContain('**Subject:** is the wrong word here.');
  });

  it('a message that converted to nothing says so rather than leaving a gap', () => {
    const rendered = renderThread({ conversationId: 'c1', subject: 'Contrat', parts: [{ message: message(), body: '   ' }] });

    expect(rendered).toContain('_This message had no readable body._');
  });

  it('padding around a message body is trimmed away, so sections read evenly', () => {
    const rendered = renderThread({ conversationId: 'c1', subject: 'Contrat', parts: [{ message: message({ from: undefined, to: [] }), body: '\n\n  Body.  \n\n' }] });

    expect(rendered).toBe(['# Contrat', '', '## 2026-05-12 09:31 — Unknown sender', '', 'Body.'].join('\n'));
  });

  it('an empty conversation still produces its title', () => {
    expect(renderThread({ conversationId: 'c1', subject: 'Contrat', parts: [] })).toBe('# Contrat');
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

  it('a conversation with nobody named lists nobody', () => {
    expect(participantsOf([{ message: message({ from: undefined, to: [] }), body: '' }])).toEqual([]);
  });
});
