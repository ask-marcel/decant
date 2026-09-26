import { describe, expect, it } from 'bun:test';
import { assembleDirectory, renderOrgChart, renderPersonDocument } from './directory.ts';
import type { Colleague } from './directory.ts';
import type { Person } from './person.ts';

const person = (id: string, name: string, over: Partial<Person> = {}): Person => ({
  id,
  name,
  title: '',
  department: '',
  email: `${id}@example.com`,
  phones: [],
  office: '',
  enabled: true,
  member: true,
  manager: undefined,
  ...over,
});

const DANA = person('dana', 'Dana Farrow', { title: 'CEO' });
const JANE = person('jane', 'Jane Doe', {
  title: 'Head of Operations',
  department: 'Operations',
  phones: ['+31 6 1234 5678'],
  office: 'Rotterdam',
  manager: { id: 'dana', name: 'Dana Farrow' },
});
const ANN = person('ann', 'Ann Lee', { title: 'Analyst', manager: { id: 'jane', name: 'Jane Doe' } });
const GUEST = person('guest', 'Outside Consultant', { member: false, manager: { id: 'jane', name: 'Jane Doe' } });
const GONE = person('gone', 'Left Already', { enabled: false });

const TEAMS = {
  dana: ['NORTHWIND EMPLOYEES', 'Leadership'],
  jane: ['Leadership', 'NORTHWIND EMPLOYEES'],
  ann: ['NORTHWIND EMPLOYEES'],
  guest: ['NORTHWIND EMPLOYEES'],
  gone: ['NORTHWIND EMPLOYEES'],
};

describe('assembling the directory out of the profiles and the rosters', () => {
  it('a colleague carries the teams they are in and the people who report to them, each in a stable order', () => {
    const directory = assembleDirectory([ANN, JANE, DANA], TEAMS);

    expect(directory.map((entry) => entry.person.name)).toEqual(['Ann Lee', 'Dana Farrow', 'Jane Doe']);
    expect(directory.find((entry) => entry.person.id === 'jane')).toMatchObject({ teams: ['Leadership', 'NORTHWIND EMPLOYEES'], reports: [{ id: 'ann', name: 'Ann Lee' }] });
    expect(directory.find((entry) => entry.person.id === 'dana')?.reports).toEqual([{ id: 'jane', name: 'Jane Doe' }]);
  });

  it('a guest and a disabled account are left out, and count as nobody`s report', () => {
    const directory = assembleDirectory([JANE, GUEST, GONE], TEAMS);

    expect(directory.map((entry) => entry.person.id)).toEqual(['jane']);
    expect(directory[0]?.reports).toHaveLength(0);
  });

  it('a colleague the rosters did not name is still a colleague, in no team', () => {
    expect(assembleDirectory([JANE], {})[0]?.teams).toEqual([]);
  });

  it('two colleagues who differ only in their reports fingerprint differently', () => {
    const alone = assembleDirectory([JANE], TEAMS)[0]?.fingerprint;
    const managing = assembleDirectory([JANE, ANN], TEAMS).find((entry) => entry.person.id === 'jane')?.fingerprint;

    expect(alone).not.toBe(managing);
  });
});

const fileOf = (id: string): string | undefined => ({ dana: 'Dana Farrow.md', jane: 'Jane Doe.md', ann: 'Ann Lee.md' })[id];

const colleague = (subject: Person, teams: ReadonlyArray<string>, reports: Colleague['reports']): Colleague => ({ person: subject, teams, reports, fingerprint: 'f' });

describe('writing one person as a document', () => {
  it('a person opens with what a colleague wants to know, then says where they sit and who reports to them, linked to their own pages', () => {
    expect(
      renderPersonDocument({ colleague: colleague(JANE, ['Leadership', 'NORTHWIND EMPLOYEES'], [{ id: 'ann', name: 'Ann Lee' }]), fileOf, syncedAt: '2026-09-11T14:00:00Z' })
    ).toBe(
      [
        '---',
        'source: Microsoft 365 directory',
        'name: Jane Doe',
        'title: Head of Operations',
        'department: Operations',
        'manager: Dana Farrow',
        'email: jane@example.com',
        'phones:',
        '  - "+31 6 1234 5678"',
        'office: Rotterdam',
        'teams:',
        '  - Leadership',
        '  - NORTHWIND EMPLOYEES',
        'synced_at: "2026-09-11T14:00:00Z"',
        '---',
        '',
        '# Jane Doe',
        '',
        'Head of Operations, Operations. Reports to [Dana Farrow](<Dana Farrow.md>).',
        '',
        '## Reports',
        '',
        '- [Ann Lee](<Ann Lee.md>)',
        '',
      ].join('\n')
    );
  });

  it('a person with no title, no manager and no reports says only their name, and a manager outside the directory is named without a link', () => {
    const written = renderPersonDocument({
      colleague: colleague(person('solo', 'Solo Person', { manager: { id: 'outside', name: 'External Boss' } }), [], []),
      fileOf,
      syncedAt: 'now',
    });

    expect(written).toContain('# Solo Person\n\nReports to External Boss.\n');
    expect(written).not.toContain('## Reports');
    expect(written).not.toContain('title:');
  });
});

describe('drawing the org chart', () => {
  it('everyone hangs under their manager, the people at the top come first, and each name links to its page', () => {
    const directory = assembleDirectory([ANN, JANE, DANA], TEAMS);

    expect(renderOrgChart(directory, fileOf)).toBe(
      ['# Org chart', '', '- [Dana Farrow](<Dana Farrow.md>), CEO', '  - [Jane Doe](<Jane Doe.md>), Head of Operations', '    - [Ann Lee](<Ann Lee.md>), Analyst', ''].join('\n')
    );
  });

  it('a person whose manager is outside the directory stands at the top, and a person with no page is named without a link', () => {
    const outsider = person('x', 'Reports Outside', { manager: { id: 'nobody-here', name: 'Someone Else' } });

    expect(renderOrgChart(assembleDirectory([outsider], {}), () => undefined)).toBe(['# Org chart', '', '- Reports Outside', ''].join('\n'));
  });

  it('a loop in the manager links, which Graph will happily store, is drawn once each and not forever', () => {
    const a = person('a', 'A', { manager: { id: 'b', name: 'B' } });
    const b = person('b', 'B', { manager: { id: 'a', name: 'A' } });

    const chart = renderOrgChart(assembleDirectory([a, b], {}), () => undefined);

    const drawn = chart
      .split('\n')
      .filter((line) => line.includes('- '))
      .map((line) => line.trim())
      .toSorted((left, right) => left.localeCompare(right));
    expect(drawn).toEqual(['- A', '- B']);
  });
});
