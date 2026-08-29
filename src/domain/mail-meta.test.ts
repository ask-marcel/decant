import { describe, expect, it } from 'bun:test';
import { attachmentRows, linkRows, renderJsonl, threadRows } from './mail-meta.ts';
import { emptyMailboxState, withAttachment, withConversation, withLinked, withThread } from './mail-state.ts';

const thread = {
  folder: '2026-05-12-d9f4e0a3c1-contrat',
  conversationIds: ['conv-1'],
  file: 'threads/2026-05-12-d9f4e0a3c1-contrat/contrat.md',
  messageIds: ['m1', 'm2'],
  lastMessage: '2026-05-13T10:00:00Z',
  attachments: ['_attachments/Contrat-a1b2.docx.md'],
  inlineImages: [],
};

const held = withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'd9f4e0a3c1', root: '<r@x>' }), 'd9f4e0a3c1', thread);

describe('indexing what a mailbox holds', () => {
  // Front matter inside a markdown file is only text. This is the file that makes "everything from
  // Li Wei since June" a query rather than a grep, so it is pinned whole: one line per thread, and
  // nothing wrapped across lines.
  it('one line per thread, carrying what a query would filter on', () => {
    const line = '{"thread_id":"d9f4e0a3c1","folder":"2026-05-12-d9f4e0a3c1-contrat","file":"threads/2026-05-12-d9f4e0a3c1-contrat/contrat.md",';
    const rest = '"conversation_ids":["conv-1"],"message_count":2,"last_message":"2026-05-13T10:00:00Z","attachments":1}\n';

    expect(renderJsonl(threadRows(held))).toBe(`${line}${rest}`);
  });

  it('a mailbox holding nothing indexes nothing, rather than a blank line', () => {
    expect(renderJsonl(threadRows(emptyMailboxState()))).toBe('');
  });

  // Sorted, not left to the order a JSON object happens to iterate in. Roughly one thread id in a
  // hundred is all digits, and an integer-like key sorts ahead of every other in an object, so an
  // unsorted index would reshuffle itself on runs that changed nothing.
  it('threads are indexed in a fixed order, so a run that changed nothing rewrites nothing', () => {
    // Inserted in reverse, and neither id is integer-like, so only an actual sort puts them right.
    const reversed = withThread(withThread(emptyMailboxState(), 'ffff000000', thread), 'aaaa111111', thread);

    expect(threadRows(reversed).map((row) => row.thread_id)).toEqual(['aaaa111111', 'ffff000000']);
  });

  // The hazard the sort exists for: an object puts an integer-like key ahead of every other one,
  // whatever order it was built in, and roughly one thread id in a hundred is all digits.
  it('an all-digit thread id is indexed in its place, not at the head', () => {
    const digits = withThread(withThread(emptyMailboxState(), 'aaaa111111', thread), '1234567890', thread);

    expect(threadRows(digits).map((row) => row.thread_id)).toEqual(['1234567890', 'aaaa111111']);
  });

  it('every row gets its own line, with nothing between them but the break', () => {
    expect(renderJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });

  it('one line per stored file, addressed by the content that named it', () => {
    const stored = withAttachment(held, 'ba7816bf8f01', {
      name: 'Contrat-ba78.docx',
      paths: ['_attachments/Contrat-ba78.docx.md'],
      primary: '_attachments/Contrat-ba78.docx.md',
      media: [],
    });

    expect(renderJsonl(attachmentRows(stored))).toBe(
      '{"content_hash":"ba7816bf8f01","name":"Contrat-ba78.docx","primary":"_attachments/Contrat-ba78.docx.md","files":["_attachments/Contrat-ba78.docx.md"]}\n'
    );
  });

  // Filtering this on a drive item is what gives every thread that ever cited one document.
  it('one line per document pointed at, keyed by the drive item it lives in', () => {
    const linked = withLinked(held, 'b!one:01ABC', { paths: ['_linked/2026-05-11/Rapport.docx.md'] });

    expect(renderJsonl(linkRows(linked))).toBe('{"item":"b!one:01ABC","files":["_linked/2026-05-11/Rapport.docx.md"]}\n');
  });

  it('a line holding a quote or a newline stays one line', () => {
    expect(renderJsonl([{ name: 'a "quoted"\nname' }])).toBe('{"name":"a \\"quoted\\"\\nname"}\n');
  });
});
