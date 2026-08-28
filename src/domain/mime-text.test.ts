import { describe, expect, it } from 'bun:test';
import { decodeBytes, decodeHeader, decodeText, unfold } from './mime-text.ts';

describe('a header written across more lines than one', () => {
  it('continued after a space, joins the line before it', () => {
    expect(unfold('To: a@example.com,\r\n b@example.com')).toEqual(['To: a@example.com, b@example.com']);
  });

  it('continued after a tab, joins it the same way', () => {
    expect(unfold('To: a@example.com,\r\n\tb@example.com')).toEqual(['To: a@example.com, b@example.com']);
  });

  it('joins the line it continues and no other', () => {
    expect(unfold('Subject: One\r\nFrom: a@example.com\r\nTo: b@example.com,\r\n c@example.com')).toEqual([
      'Subject: One',
      'From: a@example.com',
      'To: b@example.com, c@example.com',
    ]);
  });

  it('opening a block with a continuation, which continues nothing, is kept as the line it is', () => {
    expect(unfold(' orphan\r\nSubject: One')).toEqual([' orphan', 'Subject: One']);
  });

  it('written the Unix way, is read the same', () => {
    expect(unfold('To: a@example.com,\n b@example.com')).toEqual(['To: a@example.com, b@example.com']);
  });
});

describe('a header in a script ASCII cannot hold', () => {
  it('encoded whole, comes back as what it says', () => {
    expect(decodeHeader('=?utf-8?B?5Zue5aSN?= Teams Intv')).toBe('回复 Teams Intv');
  });

  it('encoded a letter at a time, comes back too, an underscore standing for a space', () => {
    expect(decodeHeader('=?utf-8?Q?Pi=C3=A8ce_jointe?=')).toBe('Pièce jointe');
  });

  it('claiming an encoding it does not hold is left as the text it is', () => {
    expect(decodeHeader('=?utf-8?B?!!!not base64!!!?=')).toBe('!!!not base64!!!');
  });

  it('in plain ASCII passes through untouched', () => {
    expect(decodeHeader('Fwd: Contrat')).toBe('Fwd: Contrat');
  });
});

describe('the encoding a transport wrapped a body in', () => {
  it('base64 comes back as the bytes it stood for', () => {
    expect(decodeBytes('QUJD', 'base64')).toEqual(new Uint8Array([65, 66, 67]));
  });

  it('base64 that is not base64 comes back as nothing, so the caller can leave that file out', () => {
    expect(decodeBytes('!!!not base64!!!', 'base64')).toBeUndefined();
  });

  it('quoted-printable comes back with its escapes read and its soft breaks closed', () => {
    expect(decodeText('Bonjour=2C=\r\n Vincent', 'quoted-printable')).toBe('Bonjour, Vincent');
  });

  it('a soft break written the Unix way is closed as well', () => {
    expect(decodeText('Bonjour=\nVincent', 'quoted-printable')).toBe('BonjourVincent');
  });

  it('a body the transport left readable is not decoded as though it had encoded it', () => {
    expect(decodeText('the sum was =41 euros', '7bit')).toBe('the sum was =41 euros');
  });

  it('text sent as base64 is read back as text', () => {
    expect(decodeText('aGVsbG8=', 'base64')).toBe('hello');
  });

  it('text whose base64 is broken keeps the text as it stands rather than losing it', () => {
    expect(decodeText('!!!not base64!!!', 'base64')).toBe('!!!not base64!!!');
  });
});
