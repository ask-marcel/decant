import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape, MarcelCommand } from './drive-reader-marcel.ts';
import { createDriveReaderFromApi } from './drive-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string>; readonly local: boolean };

const registry = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>,
  recorded: Recorded[]
): Readonly<Partial<Record<string, MarcelCommand>>> => {
  const remaining = new Map(Object.entries(answers).map(([name, list]) => [name, [...(list ?? [])]]));
  const answerFor = (name: string): Result<unknown, GraphErrorShape> => remaining.get(name)?.shift() ?? ok({});
  const command = (name: string): MarcelCommand => ({
    execute: async (_graph, params) => {
      recorded.push({ name, params, local: false });
      return answerFor(name);
    },
    executeLocal: async (_fs, params) => {
      recorded.push({ name, params, local: true });
      return answerFor(name);
    },
  });
  const names = [
    'search-all-accessible-sites',
    'search-all-files',
    'get-sharepoint-site-by-path',
    'get-sharepoint-site',
    'list-sharepoint-site-drives',
    'get-drive-root-item',
    'get-drive-delta',
    'next-page',
    'download-drive-item-as-markdown',
    'download-drive-item-as-pdf',
    'download-drive-item-content',
    'convert-local-file-to-markdown',
    'list-accessible-drives',
    'get-drive-item',
    'extract-drive-item-images',
  ];
  return Object.fromEntries(names.map((name) => [name, command(name)]));
};

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createDriveReaderFromApi>; recorded: Recorded[]; said: string[] } => {
  const recorded: Recorded[] = [];
  const said: string[] = [];
  const reader = createDriveReaderFromApi({
    graph: {},
    fs: {},
    commands: registry(answers, recorded),
    sleep: async () => undefined,
    notify: (what) => said.push(what),
  });
  return { reader, recorded, said };
};

describe('reading SharePoint through the ask-marcel library', () => {
  it('the sites the user can open come back with the name the picker shows', async () => {
    const { reader } = readerFor({
      'search-all-accessible-sites': [ok({ value: [{ id: 'contoso,1,2', displayName: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/X' }, { name: 'no id' }] })],
    });

    expect(await reader.listSites()).toEqual({ ok: true, value: [{ id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/X' }] });
  });

  it('a Loop workspace is offered beside the sites, under the identity a site lookup gives it', async () => {
    const { reader, recorded } = readerFor({
      'search-all-accessible-sites': [ok({ value: [{ id: 'contoso,1,2', displayName: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/X' }] })],
      'search-all-files': [
        ok({ value: [{ name: 'Equipe Contoso.pod', webUrl: 'https://loop.cloud.microsoft/join?podId=abc', parentReference: { siteId: 'loop.cloud.microsoft,3,4' } }] }),
      ],
      'get-sharepoint-site': [ok({ id: 'contoso,3,4', displayName: 'Equipe Contoso', webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_3' })],
    });

    expect(await reader.listSites()).toEqual({
      ok: true,
      value: [
        { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/X' },
        { id: 'contoso,3,4', name: 'Loop - Equipe Contoso', webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_3' },
      ],
    });
    // Matched by name, not position: the three listings are asked for together, so where a call
    // lands in the record is not fixed. What matters is that the pod's container id is what gets
    // looked up, and a call that never happened still fails this, since `find` answers undefined.
    expect(recorded.find((call) => call.name === 'search-all-files')?.params).toEqual({ query: 'filetype:pod' });
    expect(recorded.find((call) => call.name === 'get-sharepoint-site')?.params).toEqual({ siteId: 'loop.cloud.microsoft,3,4' });
  });

  it('a workspace manifest that names no container is left out rather than filed under nothing', async () => {
    const { reader } = readerFor({ 'search-all-files': [ok({ value: [{ name: 'Orphan.pod' }] })] });

    expect(await reader.listSites()).toEqual({ ok: true, value: [] });
  });

  it('a site reachable only through a shared library is offered beside the ones the index lists', async () => {
    const { reader } = readerFor({
      'search-all-accessible-sites': [ok({ value: [{ id: 'contoso,1,2', displayName: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/Espace' }] })],
      'list-accessible-drives': [
        ok({
          value: [
            { id: 'b!one', name: 'Documents', driveType: 'documentLibrary', webUrl: 'https://tenant.sharepoint.com/sites/Partage/Shared%20Documents' },
            { id: 'b!me', name: 'OneDrive', driveType: 'personal', webUrl: 'https://tenant-my.sharepoint.com/personal/jane/Documents' },
          ],
        }),
      ],
      'get-sharepoint-site-by-path': [ok({ id: 'contoso,9,9', displayName: 'Partage', webUrl: 'https://tenant.sharepoint.com/sites/Partage' })],
    });

    const found = await reader.listSites();

    expect(found.ok && found.value.map((site) => site.name)).toEqual(['Espace Contoso', 'Partage']);
  });

  it('a library of a site the index already lists is never resolved again', async () => {
    const { reader, recorded } = readerFor({
      'search-all-accessible-sites': [ok({ value: [{ id: 'contoso,1,2', displayName: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/Espace' }] })],
      'list-accessible-drives': [
        ok({ value: [{ id: 'b!one', name: 'Documents', driveType: 'documentLibrary', webUrl: 'https://tenant.sharepoint.com/sites/Espace/Shared%20Documents' }] }),
      ],
    });

    const found = await reader.listSites();

    expect(found.ok && found.value.map((site) => site.name)).toEqual(['Espace Contoso']);
    expect(recorded.some((call) => call.name === 'get-sharepoint-site-by-path')).toBe(false);
  });

  it('the listing says what it is waiting on, then what it is looking up', async () => {
    const { reader, said } = readerFor({
      'search-all-accessible-sites': [ok({ value: [{ id: 'contoso,1,2', displayName: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/Espace' }] })],
      'list-accessible-drives': [
        ok({ value: [{ id: 'b!one', name: 'Documents', driveType: 'documentLibrary', webUrl: 'https://tenant.sharepoint.com/sites/Partage/Shared%20Documents' }] }),
      ],
      'get-sharepoint-site-by-path': [ok({ id: 'contoso,9,9', displayName: 'Partage', webUrl: 'https://tenant.sharepoint.com/sites/Partage' })],
    });

    await reader.listSites();

    expect(said.slice(0, 2)).toEqual(['Looking for every site you can read…', 'Looking up 1 site the index did not name…']);
    expect(said.at(-1)).toBe('');
  });

  it('the three listings are asked for at once, so the slowest sets the wait', async () => {
    const { reader, recorded } = readerFor({
      'search-all-accessible-sites': [ok({ value: [] })],
      'search-all-files': [ok({ value: [{ name: 'Equipe.pod', parentReference: { siteId: 'loop.cloud.microsoft,3,4' } }] })],
      'get-sharepoint-site': [ok({ id: 'contoso,3,4', displayName: 'Equipe', webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_3' })],
      'list-accessible-drives': [ok({ value: [] })],
    });

    await reader.listSites();

    const names = recorded.map((call) => call.name);
    // Sequentially the drive listing waits behind the workspace lookup; started together it does not.
    expect(names.indexOf('list-accessible-drives')).toBeLessThan(names.indexOf('get-sharepoint-site'));
  });

  it('when more than one listing fails, the failure reported is always the same one', async () => {
    const { reader } = readerFor({
      'search-all-accessible-sites': [err({ type: 'api_error', status: 403, message: 'sites refused' })],
      'search-all-files': [err({ type: 'api_error', status: 403, message: 'pods refused' })],
      'list-accessible-drives': [err({ type: 'api_error', status: 403, message: 'drives refused' })],
    });

    expect(await reader.listSites()).toEqual({ ok: false, error: { kind: 'permanent', status: 403, message: 'sites refused' } });
  });

  it('a site address is looked up by its host and path, the way Graph addresses sites', async () => {
    const { reader, recorded } = readerFor({ 'get-sharepoint-site-by-path': [ok({ id: 'contoso,1,2', displayName: 'Espace Contoso' })] });

    const found = await reader.siteByUrl('https://tenant.sharepoint.com/sites/Espace/');

    expect(found.ok && found.value.id).toBe('contoso,1,2');
    expect(recorded[0]?.params).toEqual({ hostname: 'tenant.sharepoint.com', path: '/sites/Espace' });
  });

  it('something that is not an address is refused rather than sent to Graph', async () => {
    const { reader, recorded } = readerFor({});

    const found = await reader.siteByUrl('not an address');

    expect(found.ok === false && found.error.kind).toBe('permanent');
    expect(recorded).toEqual([]);
  });

  it('a site named by id comes back with the name the knowledge base files it under', async () => {
    const { reader, recorded } = readerFor({ 'get-sharepoint-site': [ok({ id: 'contoso,1,2', displayName: 'Espace Contoso', webUrl: 'https://x' })] });

    expect(await reader.siteById('contoso,1,2')).toEqual({ ok: true, value: { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://x' } });
    expect(recorded[0]?.params).toEqual({ siteId: 'contoso,1,2' });
  });

  it('a workspace named by its container id is filed under the name the picker offers for it', async () => {
    const { reader } = readerFor({
      'get-sharepoint-site': [ok({ id: 'contoso,3,4', displayName: 'Equipe Contoso', webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_3' })],
    });

    expect(await reader.siteById('contoso,3,4')).toEqual({
      ok: true,
      value: { id: 'contoso,3,4', name: 'Loop - Equipe Contoso', webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_3' },
    });
  });

  it('a personal workspace, whose container is named after nothing, is still filed as a workspace', async () => {
    const { reader } = readerFor({ 'get-sharepoint-site': [ok({ id: 'contoso,5,6', displayName: 'My workspace', webUrl: 'https://tenant.sharepoint.com/contentstorage/x8FNO' })] });

    expect(await reader.siteById('contoso,5,6')).toEqual({
      ok: true,
      value: { id: 'contoso,5,6', name: 'Loop - My workspace', webUrl: 'https://tenant.sharepoint.com/contentstorage/x8FNO' },
    });
  });

  it('an id no site answers to is reported rather than guessed at', async () => {
    const { reader } = readerFor({ 'get-sharepoint-site': [ok({ webUrl: 'https://x' })] });

    expect(await reader.siteById('contoso,9,9')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph returned no site' } });
  });

  it('the libraries of a site come back with their names', async () => {
    const { reader } = readerFor({ 'list-sharepoint-site-drives': [ok({ value: [{ id: 'b!one', name: 'Documents' }, { id: 'no name' }] })] });

    expect(await reader.listDrives('contoso,1,2')).toEqual({ ok: true, value: [{ id: 'b!one', name: 'Documents' }] });
  });

  it('a sweep of a library asks for the whole tree and hands back the cursor for next time', async () => {
    const { reader, recorded } = readerFor({
      'get-drive-delta': [ok({ value: [{ id: '01A', name: 'a.docx' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?%24deltatoken=abc' })],
    });

    const page = await reader.delta({ driveId: 'b!one', itemId: '01ROOT' });

    expect(page.ok && page.value.deltaLink).toBe('https://graph.microsoft.com/v1.0/delta?$deltatoken=abc');
    expect(recorded[0]?.params).toEqual({ driveId: 'b!one', itemId: '01ROOT', top: '1000' });
  });

  it('the root of a library is asked for by id alone, since that is all a sweep needs', async () => {
    const { reader, recorded } = readerFor({ 'get-drive-root-item': [ok({ id: '01ROOT', name: 'root' })] });

    expect(await reader.rootItemId('b!one')).toEqual({ ok: true, value: '01ROOT' });
    expect(recorded[0]?.params).toEqual({ driveId: 'b!one', select: 'id' });
  });

  it('a library whose root Graph did not name is reported rather than swept from nowhere', async () => {
    const { reader } = readerFor({ 'get-drive-root-item': [ok({ name: 'root' })] });

    expect(await reader.rootItemId('b!one')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph returned no root item id' } });
  });

  it('a stored cursor is followed as it was handed to us', async () => {
    const { reader, recorded } = readerFor({ 'next-page': [ok({ value: [{ id: '01A', name: 'a.docx' }] })] });

    const page = await reader.deltaFrom('https://graph.microsoft.com/v1.0/delta?$deltatoken=abc');

    expect(page.ok && page.value.items).toHaveLength(1);
    expect(recorded[0]?.params).toEqual({ url: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=abc' });
  });

  it('a cursor that leads to a shape we do not know is refused clearly', async () => {
    const { reader } = readerFor({ 'next-page': [ok({ unexpected: true })] });

    expect(await reader.deltaFrom('https://graph.microsoft.com/v1.0/delta?$deltatoken=abc')).toEqual({
      ok: false,
      error: { kind: 'permanent', message: 'delta response has no value array' },
    });
  });

  it('a document converted from a file on disk comes back as its text', async () => {
    const { reader, recorded } = readerFor({ 'convert-local-file-to-markdown': [ok({ contentType: 'text/plain', text: 'slide text' })] });

    expect(await reader.localMarkdown('kb/Site/Documents/Vieux.ppt.pdf')).toEqual({ ok: true, value: 'slide text' });
    expect(recorded[0]?.local).toBe(true);
  });

  it('a page of changes that Graph returned in a shape we do not know is refused clearly', async () => {
    const { reader } = readerFor({ 'get-drive-delta': [ok({ unexpected: true })] });

    const page = await reader.delta({ driveId: 'b!one', itemId: '01ROOT' });

    expect(page).toEqual({ ok: false, error: { kind: 'permanent', message: 'delta response has no value array' } });
  });

  it('a converted document comes back as its text', async () => {
    const { reader } = readerFor({ 'download-drive-item-as-markdown': [ok({ contentType: 'text/markdown', size: 9, text: '# Contrat' })] });

    expect(await reader.markdown({ driveId: 'b!one', itemId: '01A' })).toEqual({ ok: true, value: '# Contrat' });
  });

  it('every document conversion asks for the metadata section, so comments and tracked changes are never left behind', async () => {
    const { reader, recorded } = readerFor({ 'download-drive-item-as-markdown': [ok({ text: '# Contrat' })] });

    await reader.markdown({ driveId: 'b!one', itemId: '01A' });

    expect(recorded[0]?.params).toEqual({ driveId: 'b!one', itemId: '01A', includeMetadata: 'true' });
  });

  it('a rendered PDF comes back as the bytes it was encoded as', async () => {
    const { reader } = readerFor({ 'download-drive-item-as-pdf': [ok({ contentType: 'application/pdf', base64: Buffer.from('%PDF-1.7').toString('base64') })] });

    const rendered = await reader.pdf({ driveId: 'b!one', itemId: '01A' });

    expect(rendered.ok && new TextDecoder().decode(rendered.value)).toBe('%PDF-1.7');
  });

  it('a deck the source will not render is reported as such, not as a server that failed', async () => {
    const { reader, recorded } = readerFor({
      'download-drive-item-as-pdf': [err({ type: 'api_error', status: 406, message: 'HTTP 406 with no error body (path: /transform/pdf)' })],
    });

    const rendered = await reader.pdf({ driveId: 'b!one', itemId: '01A' });

    expect(rendered).toEqual({ ok: false, error: { kind: 'unrenderable', message: 'HTTP 406 with no error body (path: /transform/pdf)' } });
    expect(recorded).toHaveLength(1);
  });

  it('a download the library handed back as text is still written as bytes', async () => {
    const { reader } = readerFor({ 'download-drive-item-content': [ok({ contentType: 'text/plain', text: 'plain notes' })] });

    const fetched = await reader.bytes({ driveId: 'b!one', itemId: '01A' });

    expect(fetched.ok && new TextDecoder().decode(fetched.value)).toBe('plain notes');
  });

  it('a download that carried no content at all is reported rather than written as nothing', async () => {
    const { reader } = readerFor({ 'download-drive-item-content': [ok({ contentType: 'application/pdf' })] });

    expect(await reader.bytes({ driveId: 'b!one', itemId: '01A' })).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph returned no bytes' } });
  });

  it('an archive is converted on disk, one entry at a time, without going back to Graph', async () => {
    const { reader, recorded } = readerFor({
      'convert-local-file-to-markdown': [ok({ count: 2, files: [{ path: 'notes.docx', text: '# Notes' }, { path: 'video.mp4', note: 'unsupported' }, { size: 1 }] })],
    });

    const entries = await reader.localArchive('kb/Site/Documents/Livraison/Livraison.zip');

    expect(entries).toEqual({
      ok: true,
      value: [
        { path: 'notes.docx', text: '# Notes', note: undefined },
        { path: 'video.mp4', text: undefined, note: 'unsupported' },
      ],
    });
    expect(recorded[0]?.local).toBe(true);
  });

  it('a single drive item is read for the name, size and date that decide where it is filed', async () => {
    const { reader, recorded } = readerFor({
      'get-drive-item': [
        ok({
          id: '01ITEM',
          name: 'Process standardization.pptx',
          size: 240000,
          lastModifiedDateTime: '2026-05-27T09:14:00Z',
          webUrl: 'https://tenant.sharepoint.com/sites/team/Shared%20Documents/Decks/Process%20standardization.pptx',
          parentReference: { path: '/drives/b!one/root:/Decks' },
          lastModifiedBy: { user: { displayName: 'Dana Okonkwo' } },
        }),
      ],
    });

    const item = await reader.item({ driveId: 'b!one', itemId: '01ITEM' });

    expect(item.ok && item.value).toEqual({
      id: '01ITEM',
      name: 'Process standardization.pptx',
      kind: 'file',
      size: 240000,
      path: 'Decks/Process standardization.pptx',
      lastModified: '2026-05-27T09:14:00Z',
      cTag: '',
      webUrl: 'https://tenant.sharepoint.com/sites/team/Shared%20Documents/Decks/Process%20standardization.pptx',
      modifiedBy: 'Dana Okonkwo',
    });
    expect(recorded[0]).toMatchObject({ name: 'get-drive-item', params: { driveId: 'b!one', itemId: '01ITEM' } });
  });

  it('the images embedded in a document come back with the bytes and the part they came from', async () => {
    const { reader, recorded } = readerFor({
      'extract-drive-item-images': [
        ok({
          count: 2,
          media: [
            { path: 'word/media/image1.png', contentType: 'image/png', sizeBytes: 3, base64: 'AQID' },
            { path: 'word/media/image2.png', contentType: 'image/png', sizeBytes: 3, base64: 'BAUG' },
          ],
        }),
      ],
    });

    const found = await reader.images({ driveId: 'b!one', itemId: '01ITEM' });

    expect(found.ok && found.value).toEqual([
      { path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) },
      { path: 'word/media/image2.png', bytes: new Uint8Array([4, 5, 6]) },
    ]);
    expect(recorded[0]).toMatchObject({ name: 'extract-drive-item-images', params: { driveId: 'b!one', itemId: '01ITEM' } });
  });

  it('a document that embeds no images answers with none rather than failing', async () => {
    const { reader } = readerFor({ 'extract-drive-item-images': [ok({ count: 0, media: [] })] });

    expect(await reader.images({ driveId: 'b!one', itemId: '01ITEM' })).toEqual({ ok: true, value: [] });
  });

  it('an item Graph answered for in a shape we do not know is refused rather than filed from nothing', async () => {
    const { reader } = readerFor({ 'get-drive-item': [ok({ id: '01ITEM' })] });

    expect(await reader.item({ driveId: 'b!one', itemId: '01ITEM' })).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph returned no drive item' } });
  });
});

describe('reacting to the ways Graph fails', () => {
  it('a throttled call is tried again and succeeds without the caller noticing', async () => {
    const { reader, recorded } = readerFor({
      'download-drive-item-as-markdown': [err({ type: 'api_error', status: 429, retryAfterSeconds: 1, message: 'too many requests' }), ok({ text: '# Contrat' })],
    });

    expect(await reader.markdown({ driveId: 'b!one', itemId: '01A' })).toEqual({ ok: true, value: '# Contrat' });
    expect(recorded).toHaveLength(2);
  });

  it('a call that keeps being throttled gives up after a bounded number of tries', async () => {
    const throttled = err<GraphErrorShape>({ type: 'api_error', status: 429, message: 'too many requests' });
    const { reader, recorded } = readerFor({ 'download-drive-item-as-markdown': [throttled, throttled, throttled, throttled, throttled] });

    const converted = await reader.markdown({ driveId: 'b!one', itemId: '01A' });

    expect(converted.ok === false && converted.error.kind).toBe('throttled');
    expect(recorded).toHaveLength(4);
  });

  it('a server that failed momentarily is tried again', async () => {
    const { reader, recorded } = readerFor({ 'download-drive-item-as-markdown': [err({ type: 'api_error', status: 503, message: 'unavailable' }), ok({ text: '# Contrat' })] });

    expect((await reader.markdown({ driveId: 'b!one', itemId: '01A' })).ok).toBe(true);
    expect(recorded).toHaveLength(2);
  });

  it('a network that dropped is tried again', async () => {
    const { reader, recorded } = readerFor({
      'download-drive-item-as-markdown': [err({ type: 'network_error', message: 'request timed out after 60s' }), ok({ text: '# Contrat' })],
    });

    expect((await reader.markdown({ driveId: 'b!one', itemId: '01A' })).ok).toBe(true);
    expect(recorded).toHaveLength(2);
  });

  it('a document that is locked is reported at once, since trying again would fail the same way', async () => {
    const { reader, recorded } = readerFor({ 'download-drive-item-as-markdown': [err({ type: 'api_error', status: 423, message: 'locked' })] });

    const converted = await reader.markdown({ driveId: 'b!one', itemId: '01A' });

    expect(converted).toEqual({ ok: false, error: { kind: 'permanent', status: 423, message: 'locked' } });
    expect(recorded).toHaveLength(1);
  });

  it('a document locked with a password is reported as such, not as a server that failed', async () => {
    const { reader, recorded } = readerFor({
      'download-drive-item-as-markdown': [err({ type: 'api_error', status: 500, message: 'xlsx parse failed: File is password-protected' })],
    });

    const converted = await reader.markdown({ driveId: 'b!one', itemId: '01A' });

    expect(converted).toEqual({ ok: false, error: { kind: 'protected', message: 'xlsx parse failed: File is password-protected' } });
    expect(recorded).toHaveLength(1);
  });

  it('a lapsed sign-in is reported as such, so the run can stop and say so', async () => {
    const { reader } = readerFor({ 'download-drive-item-as-markdown': [err({ type: 'auth_failed', message: 'not authenticated' })] });

    const converted = await reader.markdown({ driveId: 'b!one', itemId: '01A' });

    expect(converted).toEqual({ ok: false, error: { kind: 'auth', message: 'not authenticated' } });
  });

  it('a call the library rejected as malformed is reported at once', async () => {
    const { reader, recorded } = readerFor({ 'download-drive-item-as-markdown': [err({ type: 'validation_error', message: 'itemId: expected string' })] });

    expect((await reader.markdown({ driveId: 'b!one', itemId: '01A' })).ok).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  it('a command that throws instead of answering fails that one call, not the whole run', async () => {
    const thrower: MarcelCommand = {
      execute: async () => {
        throw new Error('The string contains invalid characters.');
      },
    };
    const reader = createDriveReaderFromApi({ graph: {}, fs: {}, commands: { 'download-drive-item-content': thrower }, sleep: async () => undefined });

    expect(await reader.bytes({ driveId: 'b!one', itemId: '01A' })).toEqual({
      ok: false,
      error: { kind: 'permanent', message: 'The string contains invalid characters.' },
    });
  });

  it('a command that throws something that is not an error is still reported readably', async () => {
    const thrower: MarcelCommand = {
      execute: async () => {
        throw 'malformed base64';
      },
    };
    const reader = createDriveReaderFromApi({ graph: {}, fs: {}, commands: { 'download-drive-item-content': thrower }, sleep: async () => undefined });
    const fetched = await reader.bytes({ driveId: 'b!one', itemId: '01A' });

    expect(fetched.ok).toBe(false);
    expect(fetched.ok === false && fetched.error.message.length).toBeGreaterThan(0);
  });

  it('asking for a command this version of the library does not have is reported clearly', async () => {
    const reader = createDriveReaderFromApi({ graph: {}, fs: {}, commands: {}, sleep: async () => undefined });

    expect(await reader.listSites()).toEqual({ ok: false, error: { kind: 'permanent', message: 'unknown command: search-all-accessible-sites' } });
  });
});
