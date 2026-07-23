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
  ];
  return Object.fromEntries(names.map((name) => [name, command(name)]));
};

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createDriveReaderFromApi>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const reader = createDriveReaderFromApi({ graph: {}, fs: {}, commands: registry(answers, recorded), sleep: async () => undefined });
  return { reader, recorded };
};

describe('reading SharePoint through the ask-marcel library', () => {
  it('the sites the user can open come back with the name the picker shows', async () => {
    const { reader } = readerFor({
      'search-all-accessible-sites': [ok({ value: [{ id: 'contoso,1,2', displayName: 'Espace MOOV', webUrl: 'https://tenant.sharepoint.com/sites/X' }, { name: 'no id' }] })],
    });

    expect(await reader.listSites()).toEqual({ ok: true, value: [{ id: 'contoso,1,2', name: 'Espace MOOV', webUrl: 'https://tenant.sharepoint.com/sites/X' }] });
  });

  it('a site address is looked up by its host and path, the way Graph addresses sites', async () => {
    const { reader, recorded } = readerFor({ 'get-sharepoint-site-by-path': [ok({ id: 'contoso,1,2', displayName: 'Espace MOOV' })] });

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
    const { reader, recorded } = readerFor({ 'get-sharepoint-site': [ok({ id: 'contoso,1,2', displayName: 'Espace MOOV', webUrl: 'https://x' })] });

    expect(await reader.siteById('contoso,1,2')).toEqual({ ok: true, value: { id: 'contoso,1,2', name: 'Espace MOOV', webUrl: 'https://x' } });
    expect(recorded[0]?.params).toEqual({ siteId: 'contoso,1,2' });
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

  it('a rendered PDF comes back as the bytes it was encoded as', async () => {
    const { reader } = readerFor({ 'download-drive-item-as-pdf': [ok({ contentType: 'application/pdf', base64: Buffer.from('%PDF-1.7').toString('base64') })] });

    const rendered = await reader.pdf({ driveId: 'b!one', itemId: '01A' });

    expect(rendered.ok && new TextDecoder().decode(rendered.value)).toBe('%PDF-1.7');
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

  it('asking for a command this version of the library does not have is reported clearly', async () => {
    const reader = createDriveReaderFromApi({ graph: {}, fs: {}, commands: {}, sleep: async () => undefined });

    expect(await reader.listSites()).toEqual({ ok: false, error: { kind: 'permanent', message: 'unknown command: search-all-accessible-sites' } });
  });
});
