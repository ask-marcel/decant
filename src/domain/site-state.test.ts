import { describe, expect, it } from 'bun:test';
import { idHash } from './kb-path.ts';
import {
  belongsToAnotherSite,
  countSyncedItems,
  emptySiteState,
  forgetFailure,
  forgetItem,
  parseSiteState,
  recordItem,
  refileDrive,
  rememberFailure,
  serializeSiteState,
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
      retry: {},
    });

    expect(parseSiteState(JSON.parse(serializeSiteState(state)))).toEqual({ ok: true, value: state });
  });

  // The layout says whether the files are still in the day folders of the first one; the day and the
  // author of each change are what the library page lists a document by.
  it('a state keeps the layout its files are in and who changed each document when, and reads a layout that is not a number as none', () => {
    const library = {
      name: 'Documents',
      pending: [],
      items: { '01ABC': { path: 'Contrat.docx', cTag: 'c1', outputs: ['Contrat.docx.md'], modified: '2026-05-12T09:31:00Z', modifiedBy: 'Jane Doe' } },
      retry: {},
    };
    const state = { ...withDrive(emptySiteState(site), 'b!one', library), layout: 2 };
    const written = JSON.parse(serializeSiteState(state));

    expect(parseSiteState(written)).toEqual({ ok: true, value: state });
    expect(parseSiteState({ ...written, layout: '2' })).toMatchObject({ ok: true, value: { layout: undefined } });
  });

  // The folders tell which documents moved when Graph reports a folder at a new path. A state from
  // before they were kept has none, and the sync reads that library whole once.
  it('a state keeps the folders of each library by id, and reads folders that are not a record of paths as none', () => {
    const library = { name: 'Documents', pending: [], items: {}, retry: {}, folders: { '01F': 'Projets', '01G': 'Projets/2026' } };
    const state = withDrive(emptySiteState(site), 'b!one', library);
    const written = JSON.parse(serializeSiteState(state));
    const read = (folders: unknown): unknown => {
      const parsed = parseSiteState({ ...written, drives: { 'b!one': { ...library, folders } } });
      return parsed.ok ? parsed.value.drives['b!one']?.folders : 'unparsed';
    };

    expect(parseSiteState(written)).toEqual({ ok: true, value: state });
    expect(read(['Projets'])).toBeUndefined();
    expect(read('Projets')).toBeUndefined();
    expect(read({ '01F': 'Projets', '01G': 42 })).toEqual({ '01F': 'Projets' });
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

    expect(parsed.ok && parsed.value.drives['b!one']).toEqual({ name: '', pending: [], items: {}, retry: {} });
    expect(parsed.ok && parsed.value.drives['b!two']?.items).toEqual({});
  });

  it('an item recorded without its outputs loads with none rather than breaking the manifest', () => {
    const parsed = parseSiteState({ source: { id: 'a', name: 'b' }, drives: { 'b!one': { items: { '01': { path: 'x.docx', cTag: 'c1', outputs: ['ok', 42] } } } } });

    expect(parsed.ok && parsed.value.drives['b!one']?.items['01']).toEqual({ path: 'x.docx', cTag: 'c1', outputs: ['ok'] });
  });

  it('the file count the picker shows is the number of items across every library', () => {
    const state = withDrive(withDrive(emptySiteState(site), 'b!one', { name: 'A', pending: [], items: { a: { path: 'a', cTag: 'c', outputs: [] } }, retry: {} }), 'b!two', {
      name: 'B',
      pending: [],
      items: { b: { path: 'b', cTag: 'c', outputs: [] }, c: { path: 'c', cTag: 'c', outputs: [] } },
      retry: {},
    });

    expect(countSyncedItems(state)).toBe(3);
  });

  it('a state file recorded under a different site id belongs to someone else, even at the same path', () => {
    const state = emptySiteState({ id: 'site-a', name: 'Team Site', webUrl: '' });

    expect(belongsToAnotherSite(state, { id: 'site-b', name: 'Team Site', webUrl: '' })).toBe(true);
    expect(belongsToAnotherSite(state, { id: 'site-a', name: 'Team Site', webUrl: '' })).toBe(false);
  });

  it('the same site id always hashes to the same suffix, so a resumed run finds its own disambiguated folder', () => {
    expect(idHash('site-a')).toBe(idHash('site-a'));
    expect(idHash('site-a')).not.toBe(idHash('site-b'));
  });
});

describe('recording what happened to one document', () => {
  const drive = { name: 'Documents', pending: [], items: { '01ABC': { path: 'Contrat.docx', cTag: 'c1', outputs: ['Contrat.docx.md'] } }, retry: {} };

  it('a converted document is recorded with what it produced', () => {
    const updated = recordItem(drive, '01NEW', { path: 'Note.docx', cTag: 'c9', outputs: ['Note.docx.md'] });

    expect(updated.items['01NEW']).toEqual({ path: 'Note.docx', cTag: 'c9', outputs: ['Note.docx.md'] });
  });

  it('a document deleted in SharePoint is forgotten, so a later run does not look for it', () => {
    expect(forgetItem(drive, '01ABC').items).toEqual({});
  });

  it('forgetting one document leaves the others recorded', () => {
    const two = recordItem(drive, '01DEF', { path: 'Budget.xlsx', cTag: 'c2', outputs: ['Budget.xlsx.md'] });

    expect(Object.keys(forgetItem(two, '01ABC').items)).toStrictEqual(['01DEF']);
  });
});

describe('remembering a document the run could not read', () => {
  const item = {
    id: '01ABC',
    name: 'appendix_9.1.pdf',
    kind: 'file' as const,
    size: 4096,
    path: 'Annexes/appendix_9.1.pdf',
    lastModified: '2026-09-05T09:31:00Z',
    cTag: 'c1',
    webUrl: 'https://tenant.sharepoint.com/sites/X/appendix_9.1.pdf',
  };
  const drive = { name: 'Documents', pending: [], items: {}, retry: {} };
  const failed = { item, attempts: 1, reason: 'transient: gateway timeout' };

  it('a state file written before failures were remembered loads with an empty ledger', () => {
    const parsed = parseSiteState({ source: { id: 'a', name: 'b' }, drives: { 'b!one': { name: 'Documents', items: {} } } });

    expect(parsed.ok && parsed.value.drives['b!one']?.retry).toEqual({});
  });

  it('what one run remembers about a failure, the next run reads back unchanged', () => {
    const state = withDrive(emptySiteState(site), 'b!one', rememberFailure(drive, failed));

    expect(parseSiteState(JSON.parse(serializeSiteState(state)))).toEqual({ ok: true, value: state });
  });

  it('a failure remembered against a document is dropped once that document converts', () => {
    expect(forgetFailure(rememberFailure(drive, failed), '01ABC').retry).toEqual({});
  });

  it('forgetting a document nothing failed on leaves the ledger untouched', () => {
    const remembered = rememberFailure(drive, failed);

    expect(forgetFailure(remembered, '01OTHER')).toEqual(remembered);
  });

  it('a document no longer at the source is forgotten from the ledger as well as the manifest', () => {
    const both = rememberFailure(recordItem(drive, '01ABC', { path: 'Annexes/appendix_9.1.pdf', cTag: 'c1', outputs: [] }), failed);
    const forgotten = forgetItem(both, '01ABC');

    expect(forgotten.items).toEqual({});
    expect(forgotten.retry).toEqual({});
  });
});

describe('filing a library again in the layout without day folders', () => {
  const drive = {
    name: 'Documents',
    pending: [],
    items: {
      '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/S/D/2026-05-12/Projets/Contrat.docx.md', 'kb/S/D/2026-05-12/Projets/Contrat.docx.pdf'] },
      '01NEW': { path: 'Notes.txt', cTag: 'c1', outputs: ['kb/S/D/Notes.txt.md'] },
    },
    retry: {},
  };

  it('each document leaves the day folder for its folders in the library, and one already there stays put', () => {
    const refiled = refileDrive('kb/S/D', drive);

    expect(refiled.moves).toEqual([
      { from: 'kb/S/D/2026-05-12/Projets/Contrat.docx.md', to: 'kb/S/D/Projets/Contrat.docx.md' },
      { from: 'kb/S/D/2026-05-12/Projets/Contrat.docx.pdf', to: 'kb/S/D/Projets/Contrat.docx.pdf' },
    ]);
    expect(refiled.drive.items['01ABC']?.outputs).toEqual(['kb/S/D/Projets/Contrat.docx.md', 'kb/S/D/Projets/Contrat.docx.pdf']);
    expect(refiled.drive.items['01NEW']).toEqual(drive.items['01NEW']);
  });

  // A name cut to fit Windows does not hold the full name, and an archive's first file sits in the
  // folder it was unpacked in: neither leads anywhere wrong.
  it('a document under a cut name and an archive with its members move out of the day folder, every file keeping its name', () => {
    const refiled = refileDrive('kb/S/D', {
      ...drive,
      items: {
        '01CUT': { path: 'Contrat de service avec le fournisseur.docx', cTag: 'c1', outputs: ['kb/S/D/2026-05-12/Contrat de servi-4db6e62d.docx.md'] },
        '01ZIP': { path: 'Projets/pack.zip', cTag: 'c1', outputs: ['kb/S/D/undated/Projets/pack/pack.zip', 'kb/S/D/Projets/pack/readme.txt.md'] },
      },
    });

    expect(refiled.moves).toEqual([
      { from: 'kb/S/D/2026-05-12/Contrat de servi-4db6e62d.docx.md', to: 'kb/S/D/Contrat de servi-4db6e62d.docx.md' },
      { from: 'kb/S/D/undated/Projets/pack/pack.zip', to: 'kb/S/D/Projets/pack/pack.zip' },
    ]);
    expect(refiled.drive.items['01ZIP']?.outputs).toEqual(['kb/S/D/Projets/pack/pack.zip', 'kb/S/D/Projets/pack/readme.txt.md']);
  });

  // A path too long for Windows failed as a write, and the day folder was part of the length.
  it('a document given up on because it could not be written gets its tries back, and one that failed otherwise does not', () => {
    const item = { id: '01LONG', name: 'Long report.docx', kind: 'file' as const, size: 1, path: 'Long report.docx', lastModified: '', cTag: 'c1', webUrl: '' };
    const failing = {
      ...drive,
      retry: { '01LONG': { item, attempts: 3, reason: 'write-failed: ENOENT' }, '01LOCK': { item: { ...item, id: '01LOCK' }, attempts: 3, reason: 'transient: busy' } },
    };

    const refiled = refileDrive('kb/S/D', failing);

    expect(refiled.drive.retry['01LONG']?.attempts).toBe(0);
    expect(refiled.drive.retry['01LOCK']?.attempts).toBe(3);
  });
});

describe('the folder each archive and saved email of a library unpacks into', () => {
  // A state says which folder its archives are in, so the move into the folder named for the whole file
  // runs once. A state from before reads as the first layout, which is what it holds.
  it('a state keeps the layout its archives are in, reads one that is not a number as none, and adds none to a state from before', () => {
    const state = { ...emptySiteState(site), layout: 2, archives: 2 };
    const written = JSON.parse(serializeSiteState(state));

    expect(parseSiteState(written)).toEqual({ ok: true, value: state });
    expect(parseSiteState({ ...written, archives: '2' })).toStrictEqual({ ok: true, value: { ...emptySiteState(site), layout: 2 } });
  });
});
