import { describe, expect, it } from 'bun:test';
import { parseDriveDelta } from './drive-item.ts';

const fileItem = {
  id: '01ABC',
  name: 'Roadmap.pptx',
  size: 4096,
  lastModifiedDateTime: '2026-05-12T09:31:00Z',
  cTag: '"c:{GUID},1"',
  webUrl: 'https://tenant.sharepoint.com/sites/X/Roadmap.pptx',
  file: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  lastModifiedBy: { user: { displayName: 'Jane Doe' } },
  parentReference: { driveId: 'b!one', path: '/drives/b!one/root:/Projets/2026' },
};

describe('reading a page of changes from a document library', () => {
  it('a changed file arrives with everything needed to convert and place it', () => {
    const page = parseDriveDelta({ value: [fileItem] });

    expect(page).toEqual({
      ok: true,
      value: {
        items: [
          {
            id: '01ABC',
            name: 'Roadmap.pptx',
            kind: 'file',
            size: 4096,
            path: 'Projets/2026/Roadmap.pptx',
            lastModified: '2026-05-12T09:31:00Z',
            cTag: '"c:{GUID},1"',
            webUrl: 'https://tenant.sharepoint.com/sites/X/Roadmap.pptx',
            modifiedBy: 'Jane Doe',
          },
        ],
        skipped: 0,
      },
    });
  });

  it('a file sitting at the top of the library has the library root stripped from its path', () => {
    const page = parseDriveDelta({ value: [{ ...fileItem, parentReference: { driveId: 'b!one', path: '/drives/b!one/root:' } }] });

    expect(page.ok && page.value.items[0]?.path).toBe('Roadmap.pptx');
  });

  it('a path escaped by Graph is decoded back to the name the user sees', () => {
    const page = parseDriveDelta({ value: [{ ...fileItem, parentReference: { driveId: 'b!one', path: '/drives/b!one/root:/Projets%20cl%C3%A9s' } }] });

    expect(page.ok && page.value.items[0]?.path).toBe('Projets clés/Roadmap.pptx');
  });

  it('a path Graph escaped badly is used as it came rather than ending the sweep', () => {
    const page = parseDriveDelta({ value: [{ ...fileItem, parentReference: { path: '/drives/b!one/root:/100%' } }] });

    expect(page.ok && page.value.items[0]?.path).toBe('100%/Roadmap.pptx');
  });

  it('a folder is recognised as a folder rather than something to convert', () => {
    const page = parseDriveDelta({ value: [{ id: '01F', name: 'Projets', folder: { childCount: 3 }, parentReference: { path: '/drives/b!one/root:' } }] });

    expect(page.ok && page.value.items[0]?.kind).toBe('folder');
  });

  it('an item deleted since the last run is reported as deleted', () => {
    const page = parseDriveDelta({ value: [{ id: '01ABC', name: 'Roadmap.pptx', deleted: { state: 'deleted' }, parentReference: { path: '/drives/b!one/root:' } }] });

    expect(page.ok && page.value.items[0]?.kind).toBe('deleted');
  });

  it('the cursor for the next page is handed back ready to be called again', () => {
    const page = parseDriveDelta({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/drives/b!one/root/delta?%24skiptoken=abc' });

    expect(page.ok && page.value.nextLink).toBe('https://graph.microsoft.com/v1.0/drives/b!one/root/delta?$skiptoken=abc');
  });

  it('the cursor closing the sweep is handed back so the next run reads only changes', () => {
    const page = parseDriveDelta({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/b!one/root/delta?%24deltatoken=xyz' });

    expect(page.ok && page.value.deltaLink).toBe('https://graph.microsoft.com/v1.0/drives/b!one/root/delta?$deltatoken=xyz');
  });

  it('an item Graph returned without an id is counted as skipped rather than stopping the sweep', () => {
    const page = parseDriveDelta({ value: [{ name: 'Sans identite' }, fileItem] });

    expect(page.ok && page.value.items.length).toBe(1);
    expect(page.ok && page.value.skipped).toBe(1);
  });

  it('an empty entry in the page is counted as skipped rather than stopping the sweep', () => {
    const page = parseDriveDelta({ value: [null, fileItem] });

    expect(page.ok && page.value.items.length).toBe(1);
    expect(page.ok && page.value.skipped).toBe(1);
  });

  it('an item Graph returned with a name that is not text is counted as skipped', () => {
    const page = parseDriveDelta({ value: [{ id: '01X', name: 42 }] });

    expect(page.ok && page.value).toEqual({ items: [], skipped: 1 });
  });

  it('an item Graph returned without a name is counted as skipped', () => {
    const page = parseDriveDelta({ value: [{ id: '01X' }] });

    expect(page.ok && page.value.skipped).toBe(1);
  });

  it('an item with no parent recorded is placed at the top of the library', () => {
    const page = parseDriveDelta({ value: [{ id: '01X', name: 'Orphelin.docx' }] });

    expect(page.ok && page.value.items[0]?.path).toBe('Orphelin.docx');
  });

  it('an item whose parent path does not name the library root is placed at the top', () => {
    const page = parseDriveDelta({ value: [{ ...fileItem, parentReference: { path: '/drives/b!one' } }] });

    expect(page.ok && page.value.items[0]?.path).toBe('Roadmap.pptx');
  });

  it('an item Graph returned bare still lands in the sweep with empty stamps rather than gaps', () => {
    const page = parseDriveDelta({ value: [{ id: '01X', name: 'Sans date.docx' }] });

    expect(page.ok && page.value.items[0]).toEqual({
      id: '01X',
      name: 'Sans date.docx',
      kind: 'file',
      size: 0,
      path: 'Sans date.docx',
      lastModified: '',
      cTag: '',
      webUrl: '',
      modifiedBy: undefined,
    });
  });

  it('a response that is not a page of items is rejected', () => {
    expect(parseDriveDelta({ nope: true })).toEqual({ ok: false, error: { kind: 'malformed', message: 'delta response has no value array' } });
  });

  it('a file whose modifier Graph did not name is still usable', () => {
    const page = parseDriveDelta({ value: [{ ...fileItem, lastModifiedBy: undefined }] });

    expect(page.ok && page.value.items[0]?.modifiedBy).toBeUndefined();
  });

  it('a file whose size Graph omitted counts as empty rather than breaking the plan', () => {
    const page = parseDriveDelta({ value: [{ ...fileItem, size: undefined }] });

    expect(page.ok && page.value.items[0]?.size).toBe(0);
  });
});
