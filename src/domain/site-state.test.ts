import { describe, expect, it } from 'bun:test';
import {
  belongsToAnotherSite,
  countSyncedItems,
  emptySiteState,
  forgetItem,
  parseSiteState,
  recordItem,
  renameItem,
  serializeSiteState,
  siteIdHash,
  withDrive,
} from './site-state.ts';

const site = { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/X' };

describe('remembering where a site sync got to', () => {
  it('a site never synced starts with no libraries and no last run', () => {
    expect(emptySiteState(site)).toEqual({ version: 1, source: { kind: 'site', ...site }, lastRun: '', drives: {} });
  });

  it('what one run writes, the next run reads back unchanged', () => {
    const state = withDrive(emptySiteState(site), 'b!one', {
      name: 'Documents',
      deltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=abc',
      pending: [],
      items: { '01ABC': { path: 'Contrat.docx', cTag: 'c1', outputs: ['Contrat.docx.md'] } },
    });

    expect(parseSiteState(JSON.parse(serializeSiteState(state)))).toEqual({ ok: true, value: state });
  });

  it('a state file that is not ours is rejected rather than mistaken for an empty run', () => {
    expect(parseSiteState('nope')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
    expect(parseSiteState({ version: 1 })).toEqual({ ok: false, error: { kind: 'malformed', message: 'state has no source' } });
    expect(parseSiteState({ source: { id: 'x' } })).toEqual({ ok: false, error: { kind: 'malformed', message: 'source is missing id or name' } });
  });

  it('a state file written by an older version without libraries still loads', () => {
    const parsed = parseSiteState({ source: { id: 'a', name: 'b' } });

    expect(parsed).toEqual({ ok: true, value: { version: 1, source: { kind: 'site', id: 'a', name: 'b', webUrl: '' }, lastRun: '', drives: {} } });
  });

  it('a library entry missing its parts loads as an empty library rather than failing the run', () => {
    const parsed = parseSiteState({ source: { id: 'a', name: 'b' }, drives: { 'b!one': 'broken', 'b!two': { items: { '01': 'broken' } } } });

    expect(parsed.ok && parsed.value.drives['b!one']).toEqual({ name: '', pending: [], items: {} });
    expect(parsed.ok && parsed.value.drives['b!two']?.items).toEqual({});
  });

  it('an item recorded without its outputs loads with none rather than breaking the manifest', () => {
    const parsed = parseSiteState({ source: { id: 'a', name: 'b' }, drives: { 'b!one': { items: { '01': { path: 'x.docx', cTag: 'c1', outputs: ['ok', 42] } } } } });

    expect(parsed.ok && parsed.value.drives['b!one']?.items['01']).toEqual({ path: 'x.docx', cTag: 'c1', outputs: ['ok'] });
  });

  it('the file count the picker shows is the number of items across every library', () => {
    const state = withDrive(withDrive(emptySiteState(site), 'b!one', { name: 'A', pending: [], items: { a: { path: 'a', cTag: 'c', outputs: [] } } }), 'b!two', {
      name: 'B',
      pending: [],
      items: { b: { path: 'b', cTag: 'c', outputs: [] }, c: { path: 'c', cTag: 'c', outputs: [] } },
    });

    expect(countSyncedItems(state)).toBe(3);
  });

  it('a state file recorded under a different site id belongs to someone else, even at the same path', () => {
    const state = emptySiteState({ id: 'site-a', name: 'Team Site', webUrl: '' });

    expect(belongsToAnotherSite(state, { id: 'site-b', name: 'Team Site', webUrl: '' })).toBe(true);
    expect(belongsToAnotherSite(state, { id: 'site-a', name: 'Team Site', webUrl: '' })).toBe(false);
  });

  it('the same site id always hashes to the same suffix, so a resumed run finds its own disambiguated folder', () => {
    expect(siteIdHash('site-a')).toBe(siteIdHash('site-a'));
    expect(siteIdHash('site-a')).not.toBe(siteIdHash('site-b'));
  });
});

describe('recording what happened to one document', () => {
  const drive = { name: 'Documents', pending: [], items: { '01ABC': { path: 'Contrat.docx', cTag: 'c1', outputs: ['Contrat.docx.md'] } } };

  it('a converted document is recorded with what it produced', () => {
    const updated = recordItem(drive, '01NEW', { path: 'Note.docx', cTag: 'c9', outputs: ['Note.docx.md'] });

    expect(updated.items['01NEW']).toEqual({ path: 'Note.docx', cTag: 'c9', outputs: ['Note.docx.md'] });
  });

  it('a document deleted in SharePoint is forgotten, so a later run does not look for it', () => {
    expect(forgetItem(drive, '01ABC').items).toEqual({});
  });

  it('a renamed document keeps its version but records its new place and files', () => {
    const updated = renameItem(drive, '01ABC', 'Archive/Contrat.docx', ['Archive/Contrat.docx.md']);

    expect(updated.items['01ABC']).toEqual({ path: 'Archive/Contrat.docx', cTag: 'c1', outputs: ['Archive/Contrat.docx.md'] });
  });

  it('renaming something never recorded leaves the manifest untouched', () => {
    expect(renameItem(drive, '01OTHER', 'x', [])).toEqual(drive);
  });
});
