import { describe, expect, it } from 'bun:test';
import { parseGroupPost, parseGroupThread, postRef, refParts, threadRef } from './group-thread.ts';
import type { GroupThread } from './group-thread.ts';

const GROUP = '0d3b-group';

const thread: GroupThread = { id: 'AAQkAD-thread', topic: 'Bi-Monthly Leadership Meeting', lastDelivered: '2026-07-20T10:45:14Z', hasAttachments: false };

describe('reading a group inbox thread and the posts under it', () => {
  it('a thread carries what dates it and what names it, and never Graph`s truncated preview', () => {
    const parsed = parseGroupThread({
      id: 'AAQkAD-thread',
      topic: 'Bi-Monthly Leadership Meeting',
      lastDeliveredDateTime: '2026-07-20T10:45:14Z',
      hasAttachments: true,
      preview: 'Are you OK with the below for me to sta',
    });

    expect(parsed).toEqual({ id: 'AAQkAD-thread', topic: 'Bi-Monthly Leadership Meeting', lastDelivered: '2026-07-20T10:45:14Z', hasAttachments: true });
  });

  it('a thread with no id is no thread, since nothing could be fetched or filed under it', () => {
    expect(parseGroupThread({ topic: 'No id here' })).toBeUndefined();
    expect(parseGroupThread('not a record')).toBeUndefined();
  });

  it('a thread Graph answered without a topic or a date is still a thread, just an unnamed undated one', () => {
    expect(parseGroupThread({ id: 'AAQkAD-thread' })).toEqual({ id: 'AAQkAD-thread', topic: '', lastDelivered: '', hasAttachments: false });
  });

  it('a post is read as the person who wrote it, not as the group it was posted to', () => {
    const parsed = parseGroupPost(
      {
        id: 'AAMkAD-post',
        receivedDateTime: '2026-07-20T10:45:14Z',
        hasAttachments: true,
        from: { emailAddress: { name: 'MOOV Leadership Team', address: 'MOOVLeadershipTeam@example.com' } },
        sender: { emailAddress: { name: 'Derek Bushaw', address: 'd.bushaw@example.com' } },
      },
      thread,
      GROUP
    );

    expect(parsed?.from).toEqual({ name: 'Derek Bushaw', address: 'd.bushaw@example.com' });
    expect(parsed?.received).toBe('2026-07-20T10:45:14Z');
    expect(parsed?.hasAttachments).toBe(true);
  });

  it('a post with no sender falls back to the address it came from, rather than losing the author', () => {
    const parsed = parseGroupPost({ id: 'AAMkAD-post', from: { emailAddress: { address: 'MOOVLeadershipTeam@example.com' } } }, thread, GROUP);

    expect(parsed?.from).toEqual({ name: 'MOOVLeadershipTeam@example.com', address: 'MOOVLeadershipTeam@example.com' });
  });

  it('a post takes its subject from the thread, because a post has none of its own', () => {
    const parsed = parseGroupPost({ id: 'AAMkAD-post' }, thread, GROUP);

    expect(parsed?.subject).toBe('Bi-Monthly Leadership Meeting');
    expect(parsed?.to).toEqual([]);
    expect(parsed?.isDeleted).toBe(false);
    expect(parsed?.received).toBe('');
    expect(parsed?.hasAttachments).toBe(false);
  });

  it('a post with no id is no post, and neither is a payload that is not a record', () => {
    expect(parseGroupPost({ receivedDateTime: '2026-07-20T10:45:14Z' }, thread, GROUP)).toBeUndefined();
    expect(parseGroupPost(undefined, thread, GROUP)).toBeUndefined();
  });

  it('a post with no readable sender address is read as having no author at all', () => {
    expect(parseGroupPost({ id: 'AAMkAD-post', sender: { emailAddress: {} }, from: 'not a record' }, thread, GROUP)?.from).toBeUndefined();
  });

  it('a post is addressed by its group, its thread and itself, and the three come apart unchanged', () => {
    const ref = postRef(GROUP, 'AAQkAD-thread', 'AAMkAD-post');

    expect(ref).toBe('0d3b-group|AAQkAD-thread|AAMkAD-post');
    expect(refParts(ref)).toEqual({ groupId: GROUP, threadId: 'AAQkAD-thread', postId: 'AAMkAD-post' });
    expect(parseGroupPost({ id: 'AAMkAD-post' }, thread, GROUP)?.id).toBe('0d3b-group|AAQkAD-thread|AAMkAD-post');
  });

  it('a thread is addressed by the first two parts alone, which is what asking for a conversation asks with', () => {
    expect(threadRef(GROUP, 'AAQkAD-thread')).toBe('0d3b-group|AAQkAD-thread');
    expect(refParts(threadRef(GROUP, 'AAQkAD-thread'))).toEqual({ groupId: GROUP, threadId: 'AAQkAD-thread', postId: '' });
    expect(parseGroupPost({ id: 'AAMkAD-post' }, thread, GROUP)?.conversationId).toBe('0d3b-group|AAQkAD-thread');
  });

  it('an id that was never a reference comes apart into nothing, rather than into a wrong half', () => {
    expect(refParts('AAMkAD-a-plain-message-id')).toBeUndefined();
  });
});
