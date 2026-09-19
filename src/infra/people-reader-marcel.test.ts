import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';
import { createPeopleReaderFromCall } from './people-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createPeopleReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createPeopleReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const answer = answers[name]?.[at] ?? answers[name]?.[0] ?? ok({});
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

const MEMBER = { '@odata.type': '#microsoft.graph.aadUserConversationMember', id: 'm1', roles: [], displayName: 'Jane Doe', userId: '0000-jane', email: 'jane@example.com' };

describe('reading the directory through the ask-marcel library', () => {
  it('a roster answered a page at a time is followed to its end, and a membership with no user behind it is dropped', async () => {
    const { reader, recorded } = readerFor({
      'list-team-members': [ok({ value: [MEMBER, { id: 'bot', displayName: 'Some Bot' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/teams/t/members?%24skiptoken=s' })],
      'next-page': [ok({ value: [{ ...MEMBER, id: 'm2', userId: '0000-dana', displayName: 'Dana Farrow' }] })],
    });

    const members = await reader.teamMembers('team-1');

    expect(members).toEqual({
      ok: true,
      value: [
        { userId: '0000-jane', name: 'Jane Doe' },
        { userId: '0000-dana', name: 'Dana Farrow' },
      ],
    });
    expect(recorded[0]).toEqual({ name: 'list-team-members', params: { teamId: 'team-1' } });
    expect(recorded[1]).toEqual({ name: 'next-page', params: { url: 'https://graph.microsoft.com/v1.0/teams/t/members?$skiptoken=s' } });
  });

  it('a cursor pointing back at itself ends the paging rather than looping on it forever', async () => {
    const looping = ok({ value: [MEMBER], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/loop' });
    const { reader, recorded } = readerFor({ 'list-team-members': [looping], 'next-page': [looping] });

    expect((await reader.teamMembers('team-1')).ok).toBe(true);
    expect(recorded.filter((entry) => entry.name === 'next-page')).toHaveLength(1);
  });

  it('a roster page that fails fails the read, rather than handing back part of a Team as the whole of it', async () => {
    const { reader } = readerFor({
      'list-team-members': [ok({ value: [MEMBER], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' })],
      'next-page': [err({ type: 'api_error', status: 503, message: 'Graph is busy' })],
    });

    expect(await reader.teamMembers('team-1')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph is busy' } });
  });

  it('a profile is asked for with the fields a colleague wants and the manager in the same call, and answers as a person', async () => {
    const { reader, recorded } = readerFor({
      'get-user': [
        ok({
          id: '0000-jane',
          displayName: 'Jane Doe',
          jobTitle: 'Head of Operations',
          userType: 'Member',
          accountEnabled: true,
          manager: { id: '0000-dana', displayName: 'Dana Farrow' },
        }),
      ],
    });

    const person = await reader.profile('0000-jane');

    expect(person.ok && person.value).toMatchObject({ id: '0000-jane', name: 'Jane Doe', title: 'Head of Operations', manager: { id: '0000-dana', name: 'Dana Farrow' } });
    expect(recorded[0]).toEqual({
      name: 'get-user',
      params: {
        userId: '0000-jane',
        select: 'id,displayName,jobTitle,department,mail,userPrincipalName,mobilePhone,businessPhones,officeLocation,accountEnabled,userType',
        expand: 'manager($select=id,displayName)',
      },
    });
  });

  it('an answer that is not a person fails the read rather than reading as a blank colleague', async () => {
    const { reader } = readerFor({ 'get-user': [ok({ displayName: 'No id' })] });

    expect(await reader.profile('0000-x')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph returned no user for 0000-x' } });
  });
});
