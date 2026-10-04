import { renderFrontMatter, withFrontMatter } from './front-matter.ts';

// Who can open a SharePoint site, as `list-sharepoint-site-members` answers it: the people of the
// Microsoft 365 group that owns the site, and the grants on its document library. Graph does not
// say who is inside a SharePoint group, so a SharePoint group and a sharing link are a name and its
// roles, never a list of people.
export type SitePerson = { readonly name: string; readonly mail: string; readonly guest: boolean };

// A SharePoint group by its name, or a sharing link by its scope (`organization`, `anonymous`).
export type SiteGrant = { readonly name: string; readonly roles: ReadonlyArray<string> };

export type SiteMembers = {
  readonly group?: { readonly name: string; readonly mail: string };
  readonly owners: ReadonlyArray<SitePerson>;
  readonly members: ReadonlyArray<SitePerson>;
  readonly sharePointGroups: ReadonlyArray<SiteGrant>;
  readonly sharingLinks: ReadonlyArray<SiteGrant>;
  readonly note: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const textOf = (value: Record<string, unknown>, key: string): string => {
  const found = value[key];
  return typeof found === 'string' ? found : '';
};

const listOf = (value: unknown, key: string): ReadonlyArray<Record<string, unknown>> => {
  const found = isRecord(value) ? value[key] : undefined;
  return Array.isArray(found) ? found.filter(isRecord) : [];
};

const personOf = (entry: Record<string, unknown>): SitePerson[] => {
  const name = textOf(entry, 'displayName');
  return name === '' ? [] : [{ name, mail: textOf(entry, 'mail'), guest: textOf(entry, 'userType') === 'Guest' }];
};

const grantOf = (entry: Record<string, unknown>, key: string): SiteGrant[] => {
  const name = textOf(entry, key);
  const roles = Array.isArray(entry.roles) ? entry.roles.filter((role): role is string => typeof role === 'string') : [];
  return name === '' ? [] : [{ name, roles }];
};

const groupOf = (raw: unknown): Pick<SiteMembers, 'group'> => {
  const group = isRecord(raw) ? raw.group : undefined;
  if (!isRecord(group)) return {};
  const name = textOf(group, 'displayName');
  return name === '' ? {} : { group: { name, mail: textOf(group, 'mail') } };
};

export const parseSiteMembers = (raw: unknown): SiteMembers => ({
  ...groupOf(raw),
  owners: listOf(raw, 'owners').flatMap(personOf),
  members: listOf(raw, 'members').flatMap(personOf),
  sharePointGroups: listOf(raw, 'sharePointGroups').flatMap((entry) => grantOf(entry, 'name')),
  sharingLinks: listOf(raw, 'sharingLinks').flatMap((entry) => grantOf(entry, 'scope')),
  note: isRecord(raw) ? textOf(raw, 'note') : '',
});

// A site that answers with nobody (a caller Graph shows no grant to, say) gets no page: an empty
// one would read as a site nobody can open.
export const hasMembers = (found: SiteMembers): boolean =>
  found.group !== undefined || found.owners.length > 0 || found.members.length > 0 || found.sharePointGroups.length > 0 || found.sharingLinks.length > 0;

const personLine = (person: SitePerson): string => {
  const mail = person.mail === '' ? '' : ` (${person.mail})`;
  return `- ${person.name}${mail}${person.guest ? ', guest' : ''}`;
};

const grantLine = (grant: SiteGrant): string => `- ${grant.name}: ${grant.roles.join(', ')}`;

const section = (heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> => (lines.length === 0 ? [] : [`## ${heading}`, '', ...lines, '']);

export const renderSiteMembers = (site: { readonly name: string; readonly webUrl: string }, found: SiteMembers): string => {
  const frontMatter = renderFrontMatter([
    ['source', site.webUrl],
    ['site', site.name],
    ['group', found.group?.name],
    ['group_mail', found.group?.mail === '' ? undefined : found.group?.mail],
  ]);
  const body = [
    `# Who can open ${site.name}`,
    '',
    ...section('Owners', found.owners.map(personLine)),
    ...section('Members', found.members.map(personLine)),
    ...section('SharePoint groups', found.sharePointGroups.map(grantLine)),
    ...section('Sharing links', found.sharingLinks.map(grantLine)),
    ...(found.note === '' ? [] : [`> ${found.note}`]),
  ];
  return withFrontMatter(frontMatter, body.join('\n'));
};
