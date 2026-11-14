import { describe, expect, it } from 'bun:test';
import { libraryFolderOf, officeDocumentOf, parseGetTarget } from './get-target.ts';

describe('telling what one thing to get is', () => {
  it('an address on SharePoint is a file, whatever form the address has', () => {
    const plain = 'https://contoso.sharepoint.com/sites/Pepco/Shared%20Documents/QBR.pptx';
    const office = 'https://contoso.sharepoint.com/sites/Pepco/_layouts/15/Doc.aspx?sourcedoc=%7BABC%7D&file=QBR.pptx';

    expect(parseGetTarget(plain)).toEqual({ ok: true, value: { kind: 'file', url: plain } });
    expect(parseGetTarget(office)).toEqual({ ok: true, value: { kind: 'file', url: office } });
  });

  it('an address on a personal OneDrive, and a short link to one, is a file', () => {
    const personal = 'https://contoso-my.sharepoint.com/personal/jane_contoso_com/Documents/Notes.docx';

    expect(parseGetTarget(personal)).toEqual({ ok: true, value: { kind: 'file', url: personal } });
    expect(parseGetTarget('https://1drv.ms/w/s!AbCdEf')).toEqual({ ok: true, value: { kind: 'file', url: 'https://1drv.ms/w/s!AbCdEf' } });
  });

  it('an address in Outlook on the web is a mail, to find by its link', () => {
    const link = 'https://outlook.office365.com/owa/?ItemID=AAMkAGI%3D&exvsurl=1&viewmodel=ReadMessageItem';

    expect(parseGetTarget(link)).toEqual({ ok: true, value: { kind: 'mail-link', url: link } });
    expect(parseGetTarget('https://outlook.office.com/mail/inbox/id/AAMkAGI%3D')).toMatchObject({ value: { kind: 'mail-link' } });
  });

  it('text that is no address is the id of a mail, with the space around it taken off', () => {
    expect(parseGetTarget('  AAMkAGI2TG93AAA=  ')).toEqual({ ok: true, value: { kind: 'mail', id: 'AAMkAGI2TG93AAA=' } });
  });

  it('an address anywhere else is refused, since nothing says what it is', () => {
    expect(parseGetTarget('https://example.com/file.docx')).toEqual({ ok: false, error: { kind: 'unknown-address', host: 'example.com' } });
    expect(parseGetTarget('')).toEqual({ ok: false, error: { kind: 'empty' } });
  });
});

// A picked file is filed under the site and the library it sits in, read off the address of the
// library, so two files of one name in two libraries do not land on each other.
describe('naming the folder a picked file goes under', () => {
  it('a library of a site is named by the site and the library', () => {
    expect(libraryFolderOf('https://contoso.sharepoint.com/sites/Pepco/Shared%20Documents')).toBe('Pepco/Shared Documents');
    expect(libraryFolderOf('https://contoso.sharepoint.com/teams/Atlas/Documents')).toBe('Atlas/Documents');
  });

  it('a personal OneDrive is named by its owner and the library', () => {
    expect(libraryFolderOf('https://contoso-my.sharepoint.com/personal/jane_contoso_com/Documents')).toBe('jane_contoso_com/Documents');
  });

  it('a library of the root site is named by the library alone', () => {
    expect(libraryFolderOf('https://contoso.sharepoint.com/Shared%20Documents')).toBe('Shared Documents');
  });

  it('a part of the address that cannot be decoded is kept as it came', () => {
    expect(libraryFolderOf('https://contoso.sharepoint.com/sites/Growth 100%/Documents')).toBe('Growth%20100%/Documents');
  });

  it('an address that names no folder gives none, so the caller falls back to something else', () => {
    expect(libraryFolderOf('https://contoso.sharepoint.com/')).toBeUndefined();
    expect(libraryFolderOf('not an address')).toBeUndefined();
  });
});

// The address Office gives a document it opens: it names the document by an id and by its file name,
// and not by where it sits. Graph does not resolve it as it resolves a sharing link.
describe('reading the address Office gives a document', () => {
  const OFFICE =
    'https://contoso.sharepoint.com/sites/Pepco/_layouts/15/Doc.aspx?sourcedoc=%7BDDD1F173-2537-4C71-B5A4-647661EDF798%7D&file=SOP+version5.+02+March.docx&action=default&mobileredirect=true';

  it('the id of the document and its file name are read out, the id in lower case and without its braces', () => {
    expect(officeDocumentOf(OFFICE)).toEqual({ id: 'ddd1f173-2537-4c71-b5a4-647661edf798', name: 'SOP version5. 02 March.docx' });
  });

  it('an address that sits at a path, a link from Copy link, and text that is no address are not such an address', () => {
    expect(officeDocumentOf('https://contoso.sharepoint.com/sites/Pepco/Shared%20Documents/QBR.pptx')).toBeUndefined();
    expect(officeDocumentOf('https://contoso.sharepoint.com/:w:/s/Pepco/EabcDEF')).toBeUndefined();
    expect(officeDocumentOf('AAMkAGI=')).toBeUndefined();
  });

  it('an Office address that names no document or no file is not one decant can follow', () => {
    expect(officeDocumentOf('https://contoso.sharepoint.com/sites/Pepco/_layouts/15/Doc.aspx?file=QBR.pptx')).toBeUndefined();
    expect(officeDocumentOf('https://contoso.sharepoint.com/sites/Pepco/_layouts/15/Doc.aspx?sourcedoc=%7BDDD1F173%7D')).toBeUndefined();
  });
});
