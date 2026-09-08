import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';
import { createGroupReaderFromCall } from './group-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createGroupReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createGroupReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const answer = answers[name]?.[at] ?? answers[name]?.[0] ?? ok({});
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

const THREAD = { id: 'AAQkAD-thread', topic: 'Bi-Monthly Leadership Meeting', lastDeliveredDateTime: '2026-07-20T10:45:14Z', hasAttachments: false };

describe('reading a group inbox through the ask-marcel library', () => {
  it('only the groups with a mailbox are offered, since a security group has none to read', async () => {
    const { reader } = readerFor({
      'list-my-memberships': [
        ok({
          value: [
            { id: '0d3b-group', displayName: 'MOOV Leadership Team', mail: 'MOOVLeadershipTeam@example.com', groupTypes: ['Unified'] },
            { id: 'sec-group', displayName: 'external file sharing security group', mail: null, groupTypes: [] },
            { id: 'dist-group', displayName: 'A distribution list', mail: 'dist@example.com', groupTypes: [] },
          ],
        }),
      ],
    });

    expect(await reader.listGroups()).toEqual({ ok: true, value: [{ id: '0d3b-group', name: 'MOOV Leadership Team', mail: 'MOOVLeadershipTeam@example.com' }] });
  });

  it('a group whose name Graph withheld is offered under its address, so it is still choosable', async () => {
    const { reader } = readerFor({ 'list-my-memberships': [ok({ value: [{ id: '0d3b-group', mail: 'MOOVLeadershipTeam@example.com', groupTypes: ['Unified'] }] })] });

    expect(await reader.listGroups()).toEqual({ ok: true, value: [{ id: '0d3b-group', name: 'MOOVLeadershipTeam@example.com', mail: 'MOOVLeadershipTeam@example.com' }] });
  });

  it('threads are asked for newest first, which is the only ordering an incremental sweep can use', async () => {
    const { reader, recorded } = readerFor({ 'list-group-threads': [ok({ value: [THREAD] })] });

    const threads = await reader.threads('0d3b-group');

    expect(threads).toEqual({ ok: true, value: [{ id: 'AAQkAD-thread', topic: 'Bi-Monthly Leadership Meeting', lastDelivered: '2026-07-20T10:45:14Z', hasAttachments: false }] });
    expect(recorded[0]?.params).toMatchObject({ groupId: '0d3b-group', orderby: 'lastDeliveredDateTime desc' });
  });

  it('a truncated listing is followed to its end, so a long-lived group is read whole', async () => {
    const { reader, recorded } = readerFor({
      'list-group-threads': [
        ok({ value: [THREAD], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/0d3b/threads?$skip=50' }),
        ok({ value: [{ ...THREAD, id: 'AAQkAD-second' }] }),
      ],
    });

    const threads = await reader.threads('0d3b-group');

    expect(threads.ok && threads.value.map((thread) => thread.id)).toEqual(['AAQkAD-thread', 'AAQkAD-second']);
    expect(recorded[1]?.params).toEqual({ url: 'https://graph.microsoft.com/v1.0/groups/0d3b/threads?$skip=50' });
  });

  it('the posts of a thread come back as messages, named by the person who wrote them', async () => {
    const { reader, recorded } = readerFor({
      'list-group-threads': [ok({ value: [THREAD] })],
      'list-group-thread-posts': [
        ok({ value: [{ id: 'AAMkAD-post', receivedDateTime: '2026-07-20T10:45:14Z', sender: { emailAddress: { name: 'Derek Bushaw', address: 'd.bushaw@example.com' } } }] }),
      ],
    });

    await reader.threads('0d3b-group');
    const posts = await reader.conversation('0d3b-group|AAQkAD-thread');

    expect(posts.ok && posts.value[0]).toMatchObject({
      id: '0d3b-group|AAQkAD-thread|AAMkAD-post',
      subject: 'Bi-Monthly Leadership Meeting',
      from: { name: 'Derek Bushaw', address: 'd.bushaw@example.com' },
    });
    expect(recorded[1]?.params).toEqual({ groupId: '0d3b-group', threadId: 'AAQkAD-thread' });
  });

  it('a post read before its thread was listed is still read, just without the topic to name it', async () => {
    const { reader } = readerFor({ 'list-group-thread-posts': [ok({ value: [{ id: 'AAMkAD-post' }] })] });

    const posts = await reader.conversation('0d3b-group|AAQkAD-thread');

    expect(posts.ok && posts.value[0]?.subject).toBe('');
  });

  it('an id that is not a reference is refused rather than sent to Graph as a path', async () => {
    const { reader, recorded } = readerFor({});

    expect(await reader.conversation('AAMkAD-a-plain-message-id')).toEqual({
      ok: false,
      error: { kind: 'permanent', message: 'not a group thread reference: AAMkAD-a-plain-message-id' },
    });
    expect(await reader.messageMarkdown('AAMkAD-a-plain-message-id')).toEqual({
      ok: false,
      error: { kind: 'permanent', message: 'not a group post reference: AAMkAD-a-plain-message-id' },
    });
    expect(recorded).toHaveLength(0);
  });

  it('a post is rendered, listed and fetched by all three parts of its reference', async () => {
    const { reader, recorded } = readerFor({
      'convert-group-post-to-markdown': [ok({ text: '**From:** Derek Bushaw' })],
      'list-group-post-attachments': [ok({ value: [{ id: 'att-1', name: 'Pre-read.pdf', contentType: 'application/pdf', size: 4096, isInline: false }] })],
      'get-group-post-attachment': [ok({ base64: 'QUJD' })],
    });
    const ref = '0d3b-group|AAQkAD-thread|AAMkAD-post';

    expect(await reader.messageMarkdown(ref)).toEqual({ ok: true, value: '**From:** Derek Bushaw' });
    expect((await reader.attachments(ref)).ok).toBe(true);
    expect(await reader.attachmentBytes(ref, 'att-1')).toEqual({ ok: true, value: new Uint8Array([65, 66, 67]) });
    expect(recorded.map((call) => call.params)).toEqual([
      { groupId: '0d3b-group', threadId: 'AAQkAD-thread', postId: 'AAMkAD-post' },
      { groupId: '0d3b-group', threadId: 'AAQkAD-thread', postId: 'AAMkAD-post' },
      { groupId: '0d3b-group', threadId: 'AAQkAD-thread', postId: 'AAMkAD-post', attachmentId: 'att-1' },
    ]);
  });

  it('the three things a group post cannot do say so, rather than answering with something wrong', async () => {
    const { reader, recorded } = readerFor({});
    const ref = '0d3b-group|AAQkAD-thread|AAMkAD-post';

    expect(await reader.attachmentPdf(ref, 'att-1')).toEqual({
      ok: false,
      error: { kind: 'unrenderable', message: 'a group post has no attachment-to-pdf command in ask-marcel-office-cli 2.5.0' },
    });
    expect(await reader.attachmentImages(ref, 'att-1')).toEqual({ ok: true, value: [] });
    expect(await reader.sharepointLinks(ref)).toEqual({ ok: true, value: [] });
    expect(recorded).toHaveLength(0);
  });

  it('a refused listing is reported rather than read as an empty group', async () => {
    const { reader } = readerFor({ 'list-group-threads': [err({ type: 'api_error', status: 403, message: 'ErrorAccessDenied' })] });

    expect(await reader.threads('0d3b-group')).toEqual({ ok: false, error: { kind: 'permanent', message: 'ErrorAccessDenied' } });
  });
});
