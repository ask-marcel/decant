import { describe, expect, it } from 'bun:test';
import { isColleague, parseMember, parsePerson, personFingerprint } from './person.ts';
import type { Person } from './person.ts';

const graphUser = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
  id: '0000-jane',
  displayName: 'Jane Doe',
  jobTitle: 'Head of Operations',
  department: 'Operations',
  mail: 'jane@example.com',
  userPrincipalName: 'jane@example.com',
  mobilePhone: '+31 6 1234 5678',
  businessPhones: ['+31 10 123 4567'],
  officeLocation: 'Rotterdam',
  accountEnabled: true,
  userType: 'Member',
  manager: { '@odata.type': '#microsoft.graph.user', id: '0000-dana', displayName: 'Dana Farrow' },
};

const person = (over: Partial<Person> = {}): Person => ({
  id: '0000-jane',
  name: 'Jane Doe',
  title: 'Head of Operations',
  department: 'Operations',
  email: 'jane@example.com',
  phones: ['+31 6 1234 5678', '+31 10 123 4567'],
  office: 'Rotterdam',
  enabled: true,
  member: true,
  manager: { id: '0000-dana', name: 'Dana Farrow' },
  ...over,
});

describe('reading a person as Graph answers for them', () => {
  it('a person carries what names them, what they do, how to reach them, and who they report to', () => {
    expect(parsePerson(graphUser)).toEqual(person());
  });

  it('a person with no manager, no phones and no title is still a person, with those left blank', () => {
    expect(parsePerson({ id: '0000-solo', displayName: 'Solo Person' })).toEqual({
      id: '0000-solo',
      name: 'Solo Person',
      title: '',
      department: '',
      email: '',
      phones: [],
      office: '',
      enabled: true,
      member: true,
      manager: undefined,
    });
  });

  it('a person with no id is nobody, and one with no display name is named by their address', () => {
    expect(parsePerson({ displayName: 'No id' })).toBeUndefined();
    expect(parsePerson('nope')).toBeUndefined();
    expect(parsePerson({ id: 'x', mail: 'x@example.com' })?.name).toBe('x@example.com');
  });

  it('a mobile number and the business numbers are one list, with blanks and repeats dropped', () => {
    expect(parsePerson({ ...graphUser, mobilePhone: null, businessPhones: ['+31 10 123 4567', '', '+31 10 123 4567'] })?.phones).toEqual(['+31 10 123 4567']);
    expect(parsePerson({ ...graphUser, businessPhones: 'not a list' })?.phones).toEqual(['+31 6 1234 5678']);
  });

  it('a guest and a disabled account are read as what they are, so the sync can leave them out', () => {
    expect(parsePerson({ ...graphUser, userType: 'Guest' })?.member).toBe(false);
    expect(parsePerson({ ...graphUser, accountEnabled: false })?.enabled).toBe(false);
  });

  it('a manager Graph answered with no id is no manager, since nothing could be linked to', () => {
    expect(parsePerson({ ...graphUser, manager: { displayName: 'Ghost' } })?.manager).toBeUndefined();
  });
});

describe('deciding who is a colleague', () => {
  it('a member with a live account is; a guest, a disabled account, and a service account with no name are not', () => {
    expect(isColleague(person())).toBe(true);
    expect(isColleague(person({ member: false }))).toBe(false);
    expect(isColleague(person({ enabled: false }))).toBe(false);
  });
});

describe('reading a Team roster entry', () => {
  it('a member is the user behind them and what they are called, never the membership record itself', () => {
    expect(
      parseMember({
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        id: 'membership-1',
        roles: [],
        displayName: 'Jane Doe',
        userId: '0000-jane',
        email: 'jane@example.com',
      })
    ).toEqual({
      userId: '0000-jane',
      name: 'Jane Doe',
    });
  });

  it('a membership with no user behind it, which a bot or an app leaves, is nobody', () => {
    expect(parseMember({ id: 'membership-2', displayName: 'Some Bot' })).toBeUndefined();
    expect(parseMember('nope')).toBeUndefined();
  });
});

describe('telling whether a person has changed since they were written', () => {
  it('the same person with the same teams and reports fingerprints the same, whatever order the lists came in', () => {
    expect(personFingerprint(person(), ['NORTHWIND EMPLOYEES', 'Leadership'], ['r2', 'r1'])).toBe(personFingerprint(person(), ['Leadership', 'NORTHWIND EMPLOYEES'], ['r1', 'r2']));
  });

  it('a new title, a new manager, a new team or a new report each change the fingerprint', () => {
    const base = personFingerprint(person(), ['NORTHWIND EMPLOYEES'], []);

    expect(personFingerprint(person({ title: 'COO' }), ['NORTHWIND EMPLOYEES'], [])).not.toBe(base);
    expect(personFingerprint(person({ manager: undefined }), ['NORTHWIND EMPLOYEES'], [])).not.toBe(base);
    expect(personFingerprint(person(), ['NORTHWIND EMPLOYEES', 'Leadership'], [])).not.toBe(base);
    expect(personFingerprint(person(), ['NORTHWIND EMPLOYEES'], ['r1'])).not.toBe(base);
  });
});
