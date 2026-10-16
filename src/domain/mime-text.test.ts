import { describe, expect, it } from 'bun:test';
import { byteString, decodeBytes, decodeHeader, decodeText, unfold } from './mime-text.ts';

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
    expect(decodeText('Bonjour=2C=\r\n Valerie', 'quoted-printable')).toBe('Bonjour, Valerie');
  });

  it('a soft break written the Unix way is closed as well', () => {
    expect(decodeText('Bonjour=\nValerie', 'quoted-printable')).toBe('BonjourValerie');
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

// A saved email is read as the bytes it holds, one character each, and each text in it is decoded in
// the charset it names: decoded as UTF-8 first, Latin-1 text and 8-bit UTF-8 both came out wrong.
describe('text in the charset a message names', () => {
  const utf8 = (text: string): string => byteString(new TextEncoder().encode(text));

  it('the bytes of a message are read one character each, and come back as the same bytes', () => {
    const every = Uint8Array.from({ length: 256 }, (_, at) => at);

    expect(decodeBytes(byteString(every), '8bit')).toStrictEqual(every);
  });

  it('a text in a charset other than UTF-8 is read in that charset, sent 8-bit or quoted-printable', () => {
    expect(decodeText('Caf\u00e9 \u00e9t\u00e9', '8bit', 'iso-8859-1')).toBe('Café été');
    expect(decodeText('Caf=E9', 'quoted-printable', 'windows-1252')).toBe('Café');
    expect(decodeText('\u0092\u00a9\u008a\u00e7', '8bit', 'shift_jis')).toBe('朝顔');
  });

  it('a text sent 8-bit in UTF-8 is read as UTF-8', () => {
    expect(decodeText(utf8('Café été'), '8bit', 'utf-8')).toBe('Café été');
    expect(decodeText(utf8('Café été'), '8bit')).toBe('Café été');
  });

  it('a charset this runtime cannot decode, or none, is read as UTF-8 when the bytes are UTF-8, and as Windows-1252 when not', () => {
    expect(decodeText(utf8('Café'), '8bit', 'x-unknown')).toBe('Café');
    expect(decodeText('Caf\u00e9', '8bit', 'iso-8859-2')).toBe('Café');
    expect(decodeText('Caf\u00e9', '8bit')).toBe('Café');
    expect(decodeText('Caf\u00e9', '8bit', 'us-ascii')).toBe('Café');
    expect(decodeText('Caf\u00e9', '8bit', 'utf-8')).toBe('Café');
  });

  it('an encoded word is read in the charset it names, a language after the charset aside', () => {
    expect(decodeHeader('=?iso-8859-1?Q?Caf=E9?=')).toBe('Café');
    expect(decodeHeader('=?ISO-8859-1*fr?Q?=E9t=E9?=')).toBe('été');
  });

  it('a header written in 8-bit text is read as the text it holds', () => {
    expect(decodeHeader(utf8('Pièce jointe.pdf'))).toBe('Pièce jointe.pdf');
    expect(decodeHeader('Pi\u00e8ce jointe.pdf')).toBe('Pièce jointe.pdf');
  });
});
