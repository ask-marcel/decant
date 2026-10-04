import { describe, expect, it } from 'bun:test';
import { hasMembers, parseSiteMembers, renderSiteMembers } from './site-members.ts';

const RAW = {
  group: { id: 'g-1', displayName: 'Contoso Team', mail: 'contoso@example.com' },
  owners: [{ id: 'u-1', displayName: 'Jane Doe', mail: 'jane@example.com', userPrincipalName: 'jane@example.com', userType: 'Member' }],
  members: [
    { id: 'u-1', displayName: 'Jane Doe', mail: 'jane@example.com', userType: 'Member' },
    { id: 'u-2', displayName: 'Sam Lee', mail: null, userPrincipalName: 'sam_partner.com#EXT#@contoso.onmicrosoft.com', userType: 'Guest' },
  ],
  sharePointGroups: [{ name: 'Contoso Team Visitors', roles: ['read'] }],
  sharingLinks: [{ scope: 'organization', roles: ['write'] }],
  note: 'Graph does not list who is inside a SharePoint group.',
};

const SITE = { name: 'Espace Contoso', webUrl: 'https://contoso.sharepoint.com/sites/espace' };

describe('reading who can open a site', () => {
  it('takes the owning group, its people, the SharePoint groups, the sharing links and the note', () => {
    expect(parseSiteMembers(RAW)).toStrictEqual({
      group: { name: 'Contoso Team', mail: 'contoso@example.com' },
      owners: [{ name: 'Jane Doe', mail: 'jane@example.com', guest: false }],
      members: [
        { name: 'Jane Doe', mail: 'jane@example.com', guest: false },
        { name: 'Sam Lee', mail: '', guest: true },
      ],
      sharePointGroups: [{ name: 'Contoso Team Visitors', roles: ['read'] }],
      sharingLinks: [{ name: 'organization', roles: ['write'] }],
      note: 'Graph does not list who is inside a SharePoint group.',
    });
  });

  it('a site no group owns, and an answer that is not an object, read as nobody', () => {
    const empty = { owners: [], members: [], sharePointGroups: [], sharingLinks: [], note: '' };
    expect(parseSiteMembers({ group: null })).toStrictEqual(empty);
    expect(parseSiteMembers('nonsense')).toStrictEqual(empty);
  });

  it('a person or a grant with no name is left out, and a role that is not text is dropped', () => {
    const parsed = parseSiteMembers({ owners: [{ mail: 'x@example.com' }, 'nonsense'], sharePointGroups: [{ roles: ['read'] }, { name: 'Owners', roles: ['owner', 7] }] });
    expect(parsed.owners).toHaveLength(0);
    expect(parsed.sharePointGroups).toStrictEqual([{ name: 'Owners', roles: ['owner'] }]);
  });

  it('a group with no mail keeps its name, and a group with no name is no group', () => {
    expect(parseSiteMembers({ group: { displayName: 'Contoso Team' } }).group).toStrictEqual({ name: 'Contoso Team', mail: '' });
    expect(parseSiteMembers({ group: { mail: 'contoso@example.com' } })).not.toHaveProperty('group');
  });

  it('an empty entry in a list is passed over, and roles that are not a list are none', () => {
    const parsed = parseSiteMembers({ members: [null, { displayName: 'Sam Lee' }], sharingLinks: [{ scope: 'organization', roles: 'read' }] });
    expect(parsed.members).toStrictEqual([{ name: 'Sam Lee', mail: '', guest: false }]);
    expect(parsed.sharingLinks).toStrictEqual([{ name: 'organization', roles: [] }]);
  });
});

describe('telling whether there is anyone to write down', () => {
  it('nobody at all is nothing to write', () => {
    expect(hasMembers(parseSiteMembers({}))).toBe(false);
  });

  it('any one of a group, a person, a SharePoint group or a link is something', () => {
    expect(hasMembers(parseSiteMembers({ group: { displayName: 'Contoso Team' } }))).toBe(true);
    expect(hasMembers(parseSiteMembers({ owners: RAW.owners }))).toBe(true);
    expect(hasMembers(parseSiteMembers({ members: RAW.members }))).toBe(true);
    expect(hasMembers(parseSiteMembers({ sharePointGroups: RAW.sharePointGroups }))).toBe(true);
    expect(hasMembers(parseSiteMembers({ sharingLinks: RAW.sharingLinks }))).toBe(true);
  });
});

describe('writing who can open a site', () => {
  it('names the site and its group, then each list under its own heading, then the note', () => {
    expect(renderSiteMembers(SITE, parseSiteMembers(RAW))).toBe(
      [
        '---',
        'source: https://contoso.sharepoint.com/sites/espace',
        'site: Espace Contoso',
        'group: Contoso Team',
        'group_mail: contoso@example.com',
        '---',
        '',
        '# Who can open Espace Contoso',
        '',
        '## Owners',
        '',
        '- Jane Doe (jane@example.com)',
        '',
        '## Members',
        '',
        '- Jane Doe (jane@example.com)',
        '- Sam Lee, guest',
        '',
        '## SharePoint groups',
        '',
        '- Contoso Team Visitors: read',
        '',
        '## Sharing links',
        '',
        '- organization: write',
        '',
        '> Graph does not list who is inside a SharePoint group.',
        '',
      ].join('\n')
    );
  });

  it('a list with nobody in it is left out, and so is an empty note', () => {
    const written = renderSiteMembers(SITE, parseSiteMembers({ sharingLinks: [{ scope: 'anonymous', roles: ['read', 'write'] }] }));
    expect(written).toBe(
      [
        '---',
        'source: https://contoso.sharepoint.com/sites/espace',
        'site: Espace Contoso',
        '---',
        '',
        '# Who can open Espace Contoso',
        '',
        '## Sharing links',
        '',
        '- anonymous: read, write',
        '',
      ].join('\n')
    );
  });

  it('a group with no mail writes no mail line', () => {
    const written = renderSiteMembers(SITE, parseSiteMembers({ group: { displayName: 'Contoso Team' } }));
    expect(written).toContain('group: Contoso Team\n---');
  });

  it('a guest with a mail shows both', () => {
    const written = renderSiteMembers(SITE, parseSiteMembers({ members: [{ displayName: 'Ann Roe', mail: 'ann@partner.com', userType: 'Guest' }] }));
    expect(written).toContain('- Ann Roe (ann@partner.com), guest\n');
  });
});
