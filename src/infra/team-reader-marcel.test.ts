import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';
import { createTeamReaderFromCall } from './team-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createTeamReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createTeamReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const answer = answers[name]?.[at] ?? answers[name]?.[0] ?? ok({});
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

const POST = {
  id: '1757491200000',
  replyToId: null,
  messageType: 'message',
  createdDateTime: '2026-09-10T08:00:00Z',
  lastModifiedDateTime: '2026-09-10T09:30:00Z',
  deletedDateTime: null,
  subject: 'Venue',
  from: { user: { id: 'u', displayName: 'Jane Doe' } },
  body: { contentType: 'html', content: '<p>Three options</p>' },
};

describe('reading a Microsoft Team through the ask-marcel library', () => {
  it('the teams Graph answers with become the teams the picker can offer, one named with nothing going under its id', async () => {
    const { reader } = readerFor({
      'list-joined-teams': [ok({ value: [{ id: 'team-1', displayName: 'MOOV Leadership', isArchived: false }, { id: 'team-2' }, { displayName: 'no id' }] })],
    });

    expect(await reader.listTeams()).toEqual({
      ok: true,
      value: [
        { id: 'team-1', name: 'MOOV Leadership' },
        { id: 'team-2', name: 'team-2' },
      ],
    });
  });

  it('the channels of a team are listed by their names', async () => {
    const { reader, recorded } = readerFor({ 'list-team-channels': [ok({ value: [{ id: '19:gen@thread.tacv2', displayName: 'General', membershipType: 'standard' }] })] });

    expect(await reader.listChannels('team-1')).toEqual({ ok: true, value: [{ id: '19:gen@thread.tacv2', name: 'General' }] });
    expect(recorded[0]).toEqual({ name: 'list-team-channels', params: { teamId: 'team-1' } });
  });

  it('a first read asks the channel for everything, fifty posts a page, and a later one follows the saved cursor instead', async () => {
    const { reader, recorded } = readerFor({
      'list-team-channel-messages-delta': [ok({ value: [POST], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/teams/t/channels/c/messages/delta?%24deltatoken=abc' })],
      'next-page': [ok({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x?$deltatoken=def' })],
    });

    const fresh = await reader.postsDelta('team-1', '19:gen@thread.tacv2', undefined);
    const later = await reader.postsDelta('team-1', '19:gen@thread.tacv2', 'https://graph.microsoft.com/v1.0/teams/t/channels/c/messages/delta?$deltatoken=abc');

    expect(fresh).toEqual({
      ok: true,
      value: {
        posts: [expect.objectContaining({ id: '1757491200000', subject: 'Venue' })],
        deltaLink: 'https://graph.microsoft.com/v1.0/teams/t/channels/c/messages/delta?$deltatoken=abc',
      },
    });
    expect(recorded[0]).toEqual({ name: 'list-team-channel-messages-delta', params: { teamId: 'team-1', channelId: '19:gen@thread.tacv2', top: '50' } });
    expect(recorded[1]).toEqual({ name: 'next-page', params: { url: 'https://graph.microsoft.com/v1.0/teams/t/channels/c/messages/delta?$deltatoken=abc' } });
    expect(later.ok && later.value.deltaLink).toBe('https://graph.microsoft.com/v1.0/x?$deltatoken=def');
  });

  it('a delta answered a page at a time is followed to its end, and the cursor handed back is the last page`s', async () => {
    const { reader, recorded } = readerFor({
      'list-team-channel-messages-delta': [ok({ value: [POST], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2?%24skiptoken=s' })],
      'next-page': [ok({ value: [{ ...POST, id: '2' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x?$deltatoken=end' })],
    });

    const delta = await reader.postsDelta('team-1', 'c', undefined);

    expect(delta.ok && delta.value.posts.map((post) => post.id)).toEqual(['1757491200000', '2']);
    expect(delta.ok && delta.value.deltaLink).toBe('https://graph.microsoft.com/v1.0/x?$deltatoken=end');
    expect(recorded[1]?.params).toEqual({ url: 'https://graph.microsoft.com/v1.0/page2?$skiptoken=s' });
  });

  it('a cursor pointing back at itself ends the paging rather than looping on it forever', async () => {
    const looping = ok({ value: [POST], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/loop' });
    const { reader, recorded } = readerFor({ 'list-team-channel-messages-delta': [looping], 'next-page': [looping] });

    const delta = await reader.postsDelta('team-1', 'c', undefined);

    expect(delta.ok && delta.value.posts).toHaveLength(2);
    expect(recorded.filter((entry) => entry.name === 'next-page')).toHaveLength(1);
  });

  it('a page that fails part way through fails the read, rather than handing back half a delta with a cursor past the rest', async () => {
    const { reader } = readerFor({
      'list-team-channel-messages-delta': [ok({ value: [POST], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' })],
      'next-page': [err({ type: 'api_error', status: 503, message: 'Graph is busy' })],
    });

    expect(await reader.postsDelta('team-1', 'c', undefined)).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph is busy' } });
  });

  it('a post renders through the library, and its text is what comes back', async () => {
    const { reader, recorded } = readerFor({
      'convert-team-channel-message-to-markdown': [ok({ contentType: 'text/markdown', size: 40, text: '### 2026-09-10 08:00 · Jane Doe\n\nThree options' })],
    });

    expect(await reader.postMarkdown('team-1', 'c', '1757491200000')).toEqual({ ok: true, value: '### 2026-09-10 08:00 · Jane Doe\n\nThree options' });
    expect(recorded[0]).toEqual({ name: 'convert-team-channel-message-to-markdown', params: { teamId: 'team-1', channelId: 'c', messageId: '1757491200000' } });
  });
});
