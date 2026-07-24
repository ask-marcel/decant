import { describe, expect, it } from 'bun:test';
import { isExcludedFolder, parseMailFolders, syncableFolders } from './mail-folder.ts';

describe('reading the folders of a mailbox', () => {
  it('a folder arrives with its name and how much it holds', () => {
    const folders = parseMailFolders({ value: [{ id: 'AAMk1', displayName: 'Archive', childFolderCount: 0, totalItemCount: 5998 }] });

    expect(folders).toEqual([{ id: 'AAMk1', name: 'Archive', childCount: 0, itemCount: 5998 }]);
  });

  it('a folder holding others reports how many, so the walk knows to look inside', () => {
    const folders = parseMailFolders({ value: [{ id: 'AAMk1', displayName: 'To_Follow', childFolderCount: 14, totalItemCount: 4 }] });

    expect(folders[0]).toEqual({ id: 'AAMk1', name: 'To_Follow', childCount: 14, itemCount: 4 });
  });

  it('a folder Graph returned without an id or a name is dropped rather than swept', () => {
    expect(parseMailFolders({ value: [{ displayName: 'No id' }, { id: 'AAMk2' }, 'broken', null] })).toEqual([]);
  });

  it('the folders that did read are kept even when others in the same page did not', () => {
    const folders = parseMailFolders({ value: [{ displayName: 'No id' }, { id: 'AAMk1', displayName: 'Inbox' }, null] });

    expect(folders).toEqual([{ id: 'AAMk1', name: 'Inbox', childCount: 0, itemCount: 0 }]);
  });

  it('counts Graph left out read as zero rather than breaking the walk', () => {
    const folders = parseMailFolders({ value: [{ id: 'AAMk1', displayName: 'Archive' }] });

    expect(folders[0]).toEqual({ id: 'AAMk1', name: 'Archive', childCount: 0, itemCount: 0 });
  });

  it('a response that is not a folder list yields nothing', () => {
    expect(parseMailFolders({ nope: true })).toEqual([]);
    expect(parseMailFolders(null)).toEqual([]);
  });
});

describe('deciding which folders hold correspondence worth keeping', () => {
  it('the bin, the junk, the drafts and the outbox are left alone', () => {
    expect(isExcludedFolder('Deleted Items')).toBe(true);
    expect(isExcludedFolder('Junk Email')).toBe(true);
    expect(isExcludedFolder('Drafts')).toBe(true);
    expect(isExcludedFolder('Outbox')).toBe(true);
  });

  it('the same folders are left alone in a French mailbox', () => {
    expect(isExcludedFolder('Éléments supprimés')).toBe(true);
    expect(isExcludedFolder('Courrier indésirable')).toBe(true);
    expect(isExcludedFolder('Brouillons')).toBe(true);
    expect(isExcludedFolder("Boîte d'envoi")).toBe(true);
  });

  it('a French mailbox that stores its folder names without accents is recognised too', () => {
    expect(isExcludedFolder('Elements supprimes')).toBe(true);
    expect(isExcludedFolder('Courrier indesirable')).toBe(true);
    expect(isExcludedFolder("Boite d'envoi")).toBe(true);
  });

  it('a name Outlook padded or capitalised differently is still recognised', () => {
    expect(isExcludedFolder('  DELETED ITEMS ')).toBe(true);
  });

  it('the folders that do hold correspondence are kept, sent mail included', () => {
    expect(isExcludedFolder('Inbox')).toBe(false);
    expect(isExcludedFolder('Sent Items')).toBe(false);
    expect(isExcludedFolder('Archive')).toBe(false);
    expect(isExcludedFolder('To_Keep')).toBe(false);
  });

  it('sent mail is kept in a French mailbox too, where only the delivery queue is skipped', () => {
    expect(isExcludedFolder('Éléments envoyés')).toBe(false);
    expect(isExcludedFolder("Boîte d'envoi")).toBe(true);
  });

  it('a folder whose name merely contains an excluded word is still synced', () => {
    expect(isExcludedFolder('Drafts of contracts')).toBe(false);
  });

  it('a whole listing is filtered down to what is worth sweeping', () => {
    const folders = [
      { id: 'a', name: 'Inbox', childCount: 0, itemCount: 67 },
      { id: 'b', name: 'Deleted Items', childCount: 2, itemCount: 36 },
      { id: 'c', name: 'Sent Items', childCount: 0, itemCount: 2405 },
    ];

    expect(syncableFolders(folders).map((folder) => folder.name)).toEqual(['Inbox', 'Sent Items']);
  });
});
