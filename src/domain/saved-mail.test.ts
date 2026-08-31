import { describe, expect, it } from 'bun:test';
import { savedMailBody } from './saved-mail.ts';

const LOGO = { name: 'Logo5_f97c665d.png', opens: 'Logo5_f97c665d.png', picture: true };
const BOOK = { name: 'Dane.xlsx', opens: 'Dane.xlsx.md', picture: false };

describe('a saved email and the parts it travelled with', () => {
  it('a picture the message pointed at is shown where it pointed', () => {
    expect(savedMailBody('Kind regards\n\n[cid:Logo5_f97c665d.png]', [LOGO])).toBe('Kind regards\n\n![Logo5_f97c665d.png](Logo5_f97c665d.png)');
  });

  // The one the mail was written to send. Nothing in the text points at it, so without the list a
  // reader is told a file is attached and given no way to reach it.
  it('a file nothing pointed at is listed, so the message says what it carried', () => {
    expect(savedMailBody('Attached the format.', [BOOK])).toBe('Attached the format.\n\n**Carried by this message:**\n- [Dane.xlsx](Dane.xlsx.md)');
  });

  it('the reading is what the list opens, when the converter made one', () => {
    expect(savedMailBody('Hi.', [{ name: 'Dane.xlsx', opens: 'Dane.xlsx', picture: false }])).toContain('- [Dane.xlsx](Dane.xlsx)');
  });

  // Shown or listed, never both: a logo put back in the signature is not also an inventory entry.
  it('a picture shown in the body is not listed again below it', () => {
    const written = savedMailBody('Regards\n\n[cid:Logo5_f97c665d.png]', [LOGO, BOOK]);

    expect(written).toContain('![Logo5_f97c665d.png](Logo5_f97c665d.png)');
    expect(written).toContain('- [Dane.xlsx](Dane.xlsx.md)');
    expect(written).not.toContain('- [Logo5_f97c665d.png]');
  });

  // Outlook leaves a reference for a picture it did not send, and there is nothing to point it at.
  it('a reference to a part that never arrived is left exactly as it stands', () => {
    expect(savedMailBody('Regards\n\n[cid:missing.png]', [LOGO])).toContain('[cid:missing.png]');
  });

  // The library refuses an image outright, so only OCR can answer for one. A picture inside a saved
  // email was kept and never read, while the same picture pasted into a message body was.
  it('what was read off a picture is shown under it, as it is in a thread', () => {
    const written = savedMailBody('Regards\n\n[cid:Logo5_f97c665d.png]', [{ ...LOGO, read: 'Tomasz Nowak' }]);

    expect(written).toContain('![Logo5_f97c665d.png](Logo5_f97c665d.png)');
    expect(written).toContain('> Tomasz Nowak');
    expect(written).toContain('read out of the picture by OCR');
  });

  // A picture nothing pointed at is shown after the text, the way a thread shows one whose
  // placeholder the conversion lost. Only what is not a picture belongs in an inventory.
  it('a picture no reference pointed at is shown after the text, not listed', () => {
    const written = savedMailBody('Hello.', [{ name: 'image.png', opens: 'image.png', picture: true, read: 'NORTHWIND' }]);

    expect(written).toBe('Hello.\n\n![image.png](image.png)\n\n_Text below was read out of the picture by OCR, so it can be wrong. Open the image above to check._\n\n> NORTHWIND');
    expect(written).not.toContain('**Carried by this message:**');
  });

  // The blocks are joined by one blank line each, so whatever the mail arrived surrounded by has to
  // come off first or the document opens on a gap.
  it('the message text is trimmed at both ends before anything is put after it', () => {
    expect(savedMailBody('\n\n  Hello.  \n\n', [])).toBe('Hello.');
  });

  it('a message that carried nothing gets no list and no trailing blank', () => {
    expect(savedMailBody('Hello.', [])).toBe('Hello.');
  });

  it('a name a markdown destination could not hold is wrapped where it is linked', () => {
    expect(savedMailBody('Hi.', [{ name: 'DC Data.xlsx', opens: 'DC Data.xlsx.md', picture: false }])).toContain('- [DC Data.xlsx](<DC Data.xlsx.md>)');
  });
});
