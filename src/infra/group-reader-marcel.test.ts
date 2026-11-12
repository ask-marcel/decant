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
            { id: '0d3b-group', displayName: 'Northwind Leadership Team', mail: 'NorthwindLeadershipTeam@example.com', groupTypes: ['Unified'] },
            { id: 'sec-group', displayName: 'external file sharing security group', mail: null, groupTypes: [] },
            { id: 'dist-group', displayName: 'A distribution list', mail: 'dist@example.com', groupTypes: [] },
          ],
        }),
      ],
    });

    expect(await reader.listGroups()).toEqual({ ok: true, value: [{ id: '0d3b-group', name: 'Northwind Leadership Team', mail: 'NorthwindLeadershipTeam@example.com' }] });
  });

  it('a group whose name Graph withheld is offered under its address, so it is still choosable', async () => {
    const { reader } = readerFor({ 'list-my-memberships': [ok({ value: [{ id: '0d3b-group', mail: 'NorthwindLeadershipTeam@example.com', groupTypes: ['Unified'] }] })] });

    expect(await reader.listGroups()).toEqual({
      ok: true,
      value: [{ id: '0d3b-group', name: 'NorthwindLeadershipTeam@example.com', mail: 'NorthwindLeadershipTeam@example.com' }],
    });
  });

  it('threads are asked for newest first, which is the only ordering an incremental sweep can use', async () => {
    const { reader, recorded } = readerFor({ 'list-group-threads': [ok({ value: [THREAD] })] });

    const threads = await reader.threads('0d3b-group');

    expect(threads).toEqual({ ok: true, value: [{ id: 'AAQkAD-thread', topic: 'Bi-Monthly Leadership Meeting', lastDelivered: '2026-07-20T10:45:14Z', hasAttachments: false }] });
    expect(recorded[0]?.params).toMatchObject({ groupId: '0d3b-group', orderby: 'lastDeliveredDateTime desc' });
  });

  it('a truncated listing is followed to its end, so a long-lived group is read whole', async () => {
    const { reader, recorded } = readerFor({
      'list-group-threads': [ok({ value: [THREAD], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/0d3b/threads?$skip=50' })],
      'next-page': [ok({ value: [{ ...THREAD, id: 'AAQkAD-second' }] })],
    });

    const threads = await reader.threads('0d3b-group');

    expect(threads.ok && threads.value.map((thread) => thread.id)).toEqual(['AAQkAD-thread', 'AAQkAD-second']);
    expect(recorded[1]).toEqual({ name: 'next-page', params: { url: 'https://graph.microsoft.com/v1.0/groups/0d3b/threads?$skip=50' } });
  });

  it('a next link pointing back at itself ends the paging rather than looping on it forever', async () => {
    const looping = ok({ value: [THREAD], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/0d3b/threads?$skip=50' });
    const { reader, recorded } = readerFor({ 'list-group-threads': [looping], 'next-page': [looping] });

    const threads = await reader.threads('0d3b-group');

    expect(threads.ok && threads.value).toHaveLength(2);
    expect(recorded.filter((entry) => entry.name === 'next-page')).toHaveLength(1);
  });

  it('the posts of a thread come back as messages, named by the person who wrote them', async () => {
    const { reader, recorded } = readerFor({
      'list-group-threads': [ok({ value: [THREAD] })],
      'list-group-thread-posts': [
        ok({ value: [{ id: 'AAMkAD-post', receivedDateTime: '2026-07-20T10:45:14Z', sender: { emailAddress: { name: 'Dana Farrow', address: 'd.farrow@example.com' } } }] }),
      ],
    });

    await reader.threads('0d3b-group');
    const posts = await reader.conversation('0d3b-group|AAQkAD-thread');

    expect(posts.ok && posts.value[0]).toMatchObject({
      id: '0d3b-group|AAQkAD-thread|AAMkAD-post',
      subject: 'Bi-Monthly Leadership Meeting',
      from: { name: 'Dana Farrow', address: 'd.farrow@example.com' },
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

  it('a file attached to a post is converted in a child process, and an embedded email still by Graph', async () => {
    const recorded: Recorded[] = [];
    const children: Array<{ readonly text: string; readonly name: string; readonly params: Record<string, string> }> = [];
    const attachments: Readonly<Record<string, unknown>> = {
      'att-file': { '@odata.type': '#microsoft.graph.fileAttachment', name: 'Pre-read.docx', base64: Buffer.from('PK word').toString('base64') },
      'att-item': { '@odata.type': '#microsoft.graph.itemAttachment', name: 'Agenda' },
    };
    const reader = createGroupReaderFromCall(
      async (name, params) => {
        recorded.push({ name, params });
        return ok(name === 'get-group-post-attachment' ? attachments[params['attachmentId'] ?? ''] : { text: '# Agenda' });
      },
      async (bytes, name, params) => {
        children.push({ text: new TextDecoder().decode(bytes), name, params });
        return ok({ text: '# Pre-read' });
      }
    );
    const ref = '0d3b-group|AAQkAD-thread|AAMkAD-post';

    expect(await reader.attachmentMarkdown(ref, 'att-file')).toEqual({ ok: true, value: '# Pre-read' });
    expect(await reader.attachmentMarkdown(ref, 'att-item')).toEqual({ ok: true, value: '# Agenda' });
    expect(children).toEqual([{ text: 'PK word', name: 'Pre-read.docx', params: {} }]);
    expect(recorded.map((call) => call.name)).toEqual(['get-group-post-attachment', 'get-group-post-attachment', 'convert-group-post-attachment-to-markdown']);
  });

  it('a post is rendered, listed and fetched by all three parts of its reference', async () => {
    const { reader, recorded } = readerFor({
      'convert-group-post-to-markdown': [ok({ text: '**From:** Dana Farrow' })],
      'list-group-post-attachments': [ok({ value: [{ id: 'att-1', name: 'Pre-read.pdf', contentType: 'application/pdf', size: 4096, isInline: false }] })],
      'get-group-post-attachment': [ok({ base64: 'QUJD' })],
    });
    const ref = '0d3b-group|AAQkAD-thread|AAMkAD-post';

    expect(await reader.messageMarkdown(ref)).toEqual({ ok: true, value: '**From:** Dana Farrow' });
    expect((await reader.attachments(ref)).ok).toBe(true);
    expect(await reader.attachmentBytes(ref, 'att-1')).toEqual({ ok: true, value: new Uint8Array([65, 66, 67]) });
    expect(recorded.map((call) => call.params)).toEqual([
      { groupId: '0d3b-group', threadId: 'AAQkAD-thread', postId: 'AAMkAD-post' },
      { groupId: '0d3b-group', threadId: 'AAQkAD-thread', postId: 'AAMkAD-post' },
      { groupId: '0d3b-group', threadId: 'AAQkAD-thread', postId: 'AAMkAD-post', attachmentId: 'att-1' },
    ]);
  });

  // The three that 2.5.0 had no command for, and 2.6.0 does. A post's attachment now reaches the
  // same three conversions a mail attachment does, addressed the way every other group command is.
  const REF = '0d3b-group|AAQkAD-thread|AAMkAD-post';
  const POST = { groupId: '0d3b-group', threadId: 'AAQkAD-thread', postId: 'AAMkAD-post' };

  it('a deck attached to a post is rendered to PDF, the way one attached to a mail is', async () => {
    const { reader, recorded } = readerFor({ 'convert-group-post-attachment-to-pdf': [ok({ base64: 'AQID' })] });

    expect(await reader.attachmentPdf(REF, 'att-1')).toEqual({ ok: true, value: new Uint8Array([1, 2, 3]) });
    expect(recorded[0]).toEqual({ name: 'convert-group-post-attachment-to-pdf', params: { ...POST, attachmentId: 'att-1' } });
  });

  it('the pictures inside an attachment on a post come back as bytes, an unreadable one dropped', async () => {
    const { reader, recorded } = readerFor({
      'extract-group-post-attachment-images': [ok({ count: 1, media: [{ path: 'word/media/image1.png', base64: 'AQID' }, { path: 'no bytes' }] })],
    });

    const found = await reader.attachmentImages(REF, 'att-1');

    expect(found.ok && found.value).toEqual([{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }]);
    expect(recorded[0]).toEqual({ name: 'extract-group-post-attachment-images', params: { ...POST, attachmentId: 'att-1' } });
  });

  it('a SharePoint link in a post body resolves to the document behind it, one that did not is dropped', async () => {
    const links = {
      links: [
        { url: 'https://x', driveId: 'b!one', itemId: '01ABC', name: 'Rapport.docx' },
        { url: 'https://y', error: 'not found' },
      ],
    };
    const { reader, recorded } = readerFor({ 'extract-sharepoint-links-in-group-post': [ok(links)] });

    expect(await reader.sharepointLinks(REF)).toEqual({ ok: true, value: [{ url: 'https://x', driveId: 'b!one', itemId: '01ABC', name: 'Rapport.docx' }] });
    expect(recorded[0]).toEqual({ name: 'extract-sharepoint-links-in-group-post', params: POST });
  });

  it('a post pointing at nothing yields nothing, which is an answer and not a failure', async () => {
    const { reader } = readerFor({ 'extract-sharepoint-links-in-group-post': [ok({ postId: 'AAMkAD-post' })] });

    expect(await reader.sharepointLinks(REF)).toEqual({ ok: true, value: [] });
  });

  it('a refused listing is reported rather than read as an empty group', async () => {
    const { reader } = readerFor({ 'list-group-threads': [err({ type: 'api_error', status: 403, message: 'ErrorAccessDenied' })] });

    expect(await reader.threads('0d3b-group')).toEqual({ ok: false, error: { kind: 'permanent', message: 'ErrorAccessDenied' } });
  });
});
