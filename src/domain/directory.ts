import { renderFrontMatter, withFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import { linkDestination } from './markdown-link.ts';
import { isColleague, personFingerprint } from './person.ts';
import type { Person } from './person.ts';

// A person as the directory holds them: their profile, the Teams they are in, and the people who
// report to them, the last two worked out from everyone else rather than asked for. The fingerprint
// covers all three, since all three are in the document.
export type Colleague = {
  readonly person: Person;
  readonly teams: ReadonlyArray<string>;
  readonly reports: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly fingerprint: string;
};

const byName = <T extends { readonly name: string }>(left: T, right: T): number => left.name.localeCompare(right.name);

// The rosters and the profiles, joined. A guest and a disabled account are left out here, once,
// so nothing downstream has to ask again, and they count as nobody's report: a manager whose only
// report has left has no reports.
export const assembleDirectory = (people: ReadonlyArray<Person>, teamsOf: Readonly<Record<string, ReadonlyArray<string>>>): ReadonlyArray<Colleague> => {
  const colleagues = people.filter(isColleague);
  return colleagues
    .map((person) => {
      const teams = [...(teamsOf[person.id] ?? [])].sort((left, right) => left.localeCompare(right));
      const reports = colleagues
        .filter((candidate) => candidate.manager?.id === person.id)
        .map((report) => ({ id: report.id, name: report.name }))
        .sort(byName);
      return {
        person,
        teams,
        reports,
        fingerprint: personFingerprint(
          person,
          teams,
          reports.map((report) => report.id)
        ),
      };
    })
    .sort((left, right) => byName(left.person, right.person));
};

// Where a person's page is, by their id, or nothing for someone with no page: a manager outside the
// directory, or a person whose page could not be written this run.
export type FileOf = (id: string) => string | undefined;

const linked = (name: string, file: string | undefined): string => (file === undefined ? name : `[${name}](${linkDestination(file)})`);

const stated = (value: string): string | undefined => (value.length > 0 ? value : undefined);

const fieldsOf = (colleague: Colleague, syncedAt: string): ReadonlyArray<FrontMatterField> => [
  ['source', 'Microsoft 365 directory'],
  ['name', colleague.person.name],
  ['title', stated(colleague.person.title)],
  ['department', stated(colleague.person.department)],
  ['manager', colleague.person.manager?.name],
  ['email', stated(colleague.person.email)],
  ['phones', colleague.person.phones],
  ['office', stated(colleague.person.office)],
  ['teams', colleague.teams],
  ['synced_at', syncedAt],
];

// One sentence saying where the person sits: what they do, where, and under whom, each part only
// when it is known.
const standing = (colleague: Colleague, fileOf: FileOf): string => {
  const role = [colleague.person.title, colleague.person.department].filter((part) => part.length > 0).join(', ');
  const manager = colleague.person.manager;
  const reportsTo = manager === undefined ? '' : `Reports to ${linked(manager.name, fileOf(manager.id))}.`;
  return [role.length === 0 ? '' : `${role}.`, reportsTo].filter((part) => part.length > 0).join(' ');
};

const bodyOf = (colleague: Colleague, fileOf: FileOf): string => {
  const where = standing(colleague, fileOf);
  const reports = colleague.reports.map((report) => `- ${linked(report.name, fileOf(report.id))}`);
  return [`# ${colleague.person.name}`, ...(where.length === 0 ? [] : ['', where]), ...(reports.length === 0 ? [] : ['', '## Reports', '', ...reports])].join('\n');
};

export type RenderPersonInput = { readonly colleague: Colleague; readonly fileOf: FileOf; readonly syncedAt: string };

export const renderPersonDocument = (input: RenderPersonInput): string =>
  withFrontMatter(renderFrontMatter(fieldsOf(input.colleague, input.syncedAt)), bodyOf(input.colleague, input.fileOf));

const INDENT = '  ';

const chartLine = (colleague: Colleague, depth: number, fileOf: FileOf): string => {
  const name = linked(colleague.person.name, fileOf(colleague.person.id));
  const label = colleague.person.title.length === 0 ? name : `${name}, ${colleague.person.title}`;
  return `${INDENT.repeat(depth)}- ${label}`;
};

// Everyone under their manager, the people at the top first. A person is drawn once: Graph will
// store a loop in the manager links without complaint, and a walk that trusted them would never
// end. Whoever the roots did not reach, which is exactly the people in such a loop, is drawn as a
// root afterwards rather than dropped.
export const renderOrgChart = (directory: ReadonlyArray<Colleague>, fileOf: FileOf): string => {
  const byId = new Map(directory.map((colleague) => [colleague.person.id, colleague]));
  const drawn = new Set<string>();
  const lines: string[] = [];
  const draw = (colleague: Colleague, depth: number): void => {
    if (drawn.has(colleague.person.id)) return;
    drawn.add(colleague.person.id);
    lines.push(chartLine(colleague, depth, fileOf));
    for (const report of colleague.reports) {
      const child = byId.get(report.id);
      if (child !== undefined) draw(child, depth + 1);
    }
  };
  for (const colleague of directory.filter((candidate) => candidate.person.manager === undefined || !byId.has(candidate.person.manager.id))) draw(colleague, 0);
  for (const colleague of directory) draw(colleague, 0);
  return ['# Org chart', '', ...lines, ''].join('\n');
};
