import { describe, expect, it } from 'bun:test';
import { savedMailBody } from './saved-mail.ts';

const LOGO = { name: 'Logo5_f97c665d.png', opens: 'Logo5_f97c665d.png' };
const BOOK = { name: 'Dane.xlsx', opens: 'Dane.xlsx.md' };

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
    expect(savedMailBody('Hi.', [{ name: 'Dane.xlsx', opens: 'Dane.xlsx' }])).toContain('- [Dane.xlsx](Dane.xlsx)');
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

  it('a message that carried nothing gets no list and no trailing blank', () => {
    expect(savedMailBody('Hello.', [])).toBe('Hello.');
  });

  it('a name a markdown destination could not hold is wrapped where it is linked', () => {
    expect(savedMailBody('Hi.', [{ name: 'DC Data.xlsx', opens: 'DC Data.xlsx.md' }])).toContain('- [DC Data.xlsx](<DC Data.xlsx.md>)');
  });
});
