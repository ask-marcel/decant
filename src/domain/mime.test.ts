import { describe, expect, it } from 'bun:test';
import { readMime } from './mime.ts';

const lines = (...parts: ReadonlyArray<string>): string => parts.join('\r\n');

// A message divided into parts, which is how anything carrying a file is written.
const multipart = (...parts: ReadonlyArray<ReadonlyArray<string>>): string =>
  lines('Subject: Carried', 'Content-Type: multipart/mixed; boundary="B"', '', ...parts.flatMap((part) => ['--B', ...part]), '--B--');

const TEXT = ['Content-Type: text/plain', '', 'the body'];

const FILE = ['Content-Type: application/pdf; name="x.pdf"', 'Content-Transfer-Encoding: base64', '', 'QUJD'];

const CARRIED = { name: 'x.pdf', contentType: 'application/pdf', bytes: new Uint8Array([65, 66, 67]) };

describe('reading a saved email', () => {
  // An Outlook message as a client writes one: a folded recipient list, a subject in a script ASCII
  // cannot hold, the text quoted-printable, and the attachment base64.
  const read = readMime(
    lines(
      'From: Tina Wu <tina@example.com>',
      'To: Vincent Delacourt <vincent@example.com>,',
      '\tBenny Zhang <benny@example.com>',
      'Subject: =?utf-8?B?5Zue5aSN?= Teams Intv',
      'Date: Mon, 24 Aug 2026 07:22:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Bonjour Vincent=2C',
      '',
      'voici le contrat en pi=C3=A8ce jointe.',
      '--BOUND',
      'Content-Type: application/vnd; name="Contrat.docx"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="Contrat.docx"',
      '',
      'QUJD',
      '--BOUND--'
    )
  );

  it('is the message and its files, and nothing of the envelope they travelled in', () => {
    expect(read.text).toBe(
      [
        '**Subject:** 回复 Teams Intv',
        '**From:** Tina Wu <tina@example.com>',
        '**To:** Vincent Delacourt <vincent@example.com>, Benny Zhang <benny@example.com>',
        '**Date:** Mon, 24 Aug 2026 07:22:00 +0000',
        '',
        'Bonjour Vincent,',
        '',
        'voici le contrat en pièce jointe.',
      ].join('\n')
    );
  });

  it('hands back the file it carried as the bytes it was, not as the base64 it travelled as', () => {
    expect(read.parts).toEqual([{ name: 'Contrat.docx', contentType: 'application/vnd', bytes: new Uint8Array([65, 66, 67]) }]);
  });
});

describe('the shapes a saved email comes in', () => {
  it('a message of nothing but text carries no files and still reads', () => {
    const read = readMime(lines('From: Tina Wu <tina@example.com>', 'Subject: No files', 'Content-Type: text/plain', '', 'Just a line.'));

    expect(read.text).toBe('**Subject:** No files\n**From:** Tina Wu <tina@example.com>\n\nJust a line.');
    expect(read.parts).toEqual([]);
  });

  it('a message written in HTML alone is read as the HTML it is, rather than as nothing', () => {
    expect(readMime(lines('Subject: Rich', 'Content-Type: text/html', '', '<p>Hello</p>')).text).toBe('**Subject:** Rich\n\n<p>Hello</p>');
  });

  it('the plain part is preferred when a message carries both, being the one worth reading', () => {
    const both = lines(
      'Subject: Both',
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      ...TEXT,
      '--B',
      'Content-Type: text/html',
      '',
      '<p>the rich one</p>',
      '--B--'
    );

    expect(readMime(both).text).toBe('**Subject:** Both\n\nthe body');
  });

  it('everyone named on a message is named on the record, and nobody who was not', () => {
    const copied = lines('Subject: Copied', 'From: a@example.com', 'To: b@example.com', 'Cc: c@example.com', 'Content-Type: text/plain', '', 'body');

    expect(readMime(copied).text).toBe('**Subject:** Copied\n**From:** a@example.com\n**To:** b@example.com\n**Cc:** c@example.com\n\nbody');
  });

  it('a header the message left empty is left out rather than written blank', () => {
    expect(readMime(lines('Subject:', 'From: a@example.com', 'Content-Type: text/plain', '', 'body')).text).toBe('**From:** a@example.com\n\nbody');
  });

  it('a message with no headers at all is read as the body it is', () => {
    expect(readMime('just text, no headers').text).toBe('just text, no headers');
  });

  it('a message whose lines end the way a Unix client writes them is read the same', () => {
    const unix = ['Subject: Unix', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'the body', '--B--'].join('\n');

    expect(readMime(unix).text).toBe('**Subject:** Unix\n\nthe body');
  });
});

describe('the files a saved email carried', () => {
  it('are taken out of the parts they were divided into', () => {
    const read = readMime(multipart(TEXT, FILE));

    expect(read.text).toBe('**Subject:** Carried\n\nthe body');
    expect(read.parts).toEqual([CARRIED]);
  });

  it('are taken out of a part nested inside a part of its own as well', () => {
    const read = readMime(multipart(['Content-Type: multipart/related; boundary="IN"', '', '--IN', ...TEXT, '--IN', ...FILE, '--IN--']));

    expect(read.text).toBe('**Subject:** Carried\n\nthe body');
    expect(read.parts).toEqual([CARRIED]);
  });

  it('keep the name the message gave them, whether it named them on the disposition or the type', () => {
    const onDisposition = multipart(['Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename=contrat.pdf', '', 'QUJD']);
    const onType = multipart(['Content-Type: application/pdf; name=devis.pdf', 'Content-Transfer-Encoding: base64', '', 'QUJD']);

    expect(readMime(onDisposition).parts.map((part) => part.name)).toEqual(['contrat.pdf']);
    expect(readMime(onType).parts.map((part) => part.name)).toEqual(['devis.pdf']);
  });

  it('get their name back when it was encoded for a 7-bit header', () => {
    const encoded = multipart([
      'Content-Type: application/pdf',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="=?utf-8?B?5ZCI5ZCMLnBkZg==?="',
      '',
      'QUJD',
    ]);

    expect(readMime(encoded).parts.map((part) => part.name)).toEqual(['合同.pdf']);
  });

  it('land under a name of their kind when the message named them not at all', () => {
    const unnamed = (kind: string): string => multipart([`Content-Type: ${kind}`, 'Content-Transfer-Encoding: base64', '', 'QUJD']);

    expect(readMime(unnamed('application/pdf')).parts.map((part) => part.name)).toEqual(['part-1.pdf']);
    expect(readMime(unnamed('image/png')).parts.map((part) => part.name)).toEqual(['part-1.png']);
    expect(readMime(unnamed('image/jpeg')).parts.map((part) => part.name)).toEqual(['part-1.jpg']);
    expect(readMime(unnamed('image/gif')).parts.map((part) => part.name)).toEqual(['part-1.gif']);
    expect(readMime(unnamed('application/octet-stream')).parts.map((part) => part.name)).toEqual(['part-1.bin']);
  });

  it('are divided on a boundary carrying the punctuation a real one carries', () => {
    const boundary = '----=_NextPart_000_0012_01DC.6A2B+1';
    const real = lines('Subject: Real', `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...TEXT, `--${boundary}`, ...FILE, `--${boundary}--`);
    const read = readMime(real);

    expect(read.text).toBe('**Subject:** Real\n\nthe body');
    expect(read.parts).toEqual([CARRIED]);
  });

  it('are divided on a boundary written bare, with spaces around it, all the same', () => {
    const bare = lines('Subject: Bare', 'Content-Type: multipart/mixed; boundary = B1', '', '--B1', ...TEXT, '--B1--');

    expect(readMime(bare).text).toBe('**Subject:** Bare\n\nthe body');
  });

  it('cost only themselves when their base64 is broken', () => {
    const read = readMime(multipart(TEXT, ['Content-Type: application/pdf; name="x.pdf"', 'Content-Transfer-Encoding: base64', '', '!!!not base64!!!']));

    expect(read.text).toBe('**Subject:** Carried\n\nthe body');
    expect(read.parts).toEqual([]);
  });

  it('are not written at all when a part is a name and no bytes', () => {
    expect(readMime(multipart(['Content-Type: application/pdf; name="x.pdf"', 'Content-Transfer-Encoding: base64', '', ''])).parts).toEqual([]);
  });

  it('leave an empty stretch between two boundaries to be passed over', () => {
    expect(readMime(multipart([''], TEXT)).text).toBe('**Subject:** Carried\n\nthe body');
  });
});
