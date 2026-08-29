import { describe, expect, it } from 'bun:test';
import { bareSubject } from './thread-subject.ts';

describe('reading what a thread is about', () => {
  it('reply and forward markers are stripped however many a chain has collected', () => {
    expect(bareSubject('RE: TR: Re: Rimowa TW store opening')).toBe('Rimowa TW store opening');
    expect(bareSubject('RE[2]: Rimowa TW store opening')).toBe('Rimowa TW store opening');
  });

  // Written out here rather than read from the module, so this states the requirement instead of
  // agreeing with whatever the code happens to hold. Every entry is a claim that a mailbox in
  // Greater China, reached by European and Asian correspondents alike, will meet this marker.
  const MARKERS = [
    'RE',
    'Rép',
    'Rep',
    'Res',
    'RV',
    'RIF',
    'AW',
    'Antwort',
    'ANTW',
    'SV',
    'VS',
    'VB',
    'VL',
    'Odp',
    'Odpověď',
    'Vá',
    'AP',
    'ΑΠ',
    'Ответ',
    'RD',
    'رد',
    'FW',
    'FWD',
    'TR',
    'WG',
    'Doorst',
    'ENC',
    'PD',
    'ILT',
    'YNT',
    '回复',
    '答复',
    '回覆',
    '返信',
    '회신',
    '답장',
    '转发',
    '轉寄',
    '전달',
    '転送',
    'Пересылка',
    'إعادة توجيه',
  ];

  it('a marker in any of the languages this mailbox sees is still a marker', () => {
    for (const marker of MARKERS) expect(bareSubject(`${marker}: Kick-off`)).toBe('Kick-off');
  });

  // CJK clients write the full-width colon, and a pattern that only knows the ASCII one leaves the
  // marker in the title of every Chinese thread.
  it('a full-width colon marks a prefix like any other', () => {
    expect(bareSubject('回复：Kick-off')).toBe('Kick-off');
  });

  it('a bracketed list or classification tag is not part of what a thread is about', () => {
    expect(bareSubject('[EXTERNAL] Rimowa TW store opening')).toBe('Rimowa TW store opening');
    expect(bareSubject('RE: TR: [EXTERNAL] Rimowa TW store opening')).toBe('Rimowa TW store opening');
    expect(bareSubject('[EXTERNAL][FGGC-IT] Kick-off')).toBe('Kick-off');
  });

  it('a subject that merely contains a marker keeps it, since only a prefix says how mail travelled', () => {
    expect(bareSubject('Contrat re: signature')).toBe('Contrat re: signature');
  });

  it('a bracket in the middle of a title is part of the title, not a tag on the front of it', () => {
    expect(bareSubject('Contrat [final] version')).toBe('Contrat [final] version');
  });

  it('a tag written tight against the subject gives the subject back whole', () => {
    expect(bareSubject('[FGGC-IT]Kick-off')).toBe('Kick-off');
  });

  // Kept deliberately: a `REF:` line is a reference, not a reply, and the mailbox this serves uses it
  // that way. It is the one entry of the published list this does not strip.
  it('a reference line is not a reply marker', () => {
    expect(bareSubject('REF: Contrat')).toBe('REF: Contrat');
  });

  it('a subject that was nothing but markers reads as having none', () => {
    expect(bareSubject('RE: FW:')).toBe('');
    expect(bareSubject('   ')).toBe('');
  });
});
