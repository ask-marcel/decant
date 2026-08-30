import { describe, expect, it } from 'bun:test';
import { contentHash } from '../domain/content-hash.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import { CONV, INLINE_STORE, THREAD_FILE, bytesOf, message, run } from '../test-helpers/thread-harness.ts';

describe('what a message body says about the files it carried', () => {
  const PASTED = { id: 'sig', name: 'logo.png', contentType: 'image/png', size: 100, isInline: true, contentId: 'logo.png@01DC1234' };
  // A picture shown inside a body is stored once for the whole mailbox, not once per thread: one
  // signature logo rides on every message its sender ever wrote. A folder every thread writes into
  // needs names that cannot collide across all of them, which is what the content address gives.
  const inlineAt = (name: string, id: string): string => `${INLINE_STORE}/${disambiguateSegment(name, contentHash(bytesOf(id)))}`;
  const shownAt = (name: string, id: string): string => `../../_inline/${disambiguateSegment(name, contentHash(bytesOf(id)))}`;

  it('a picture pasted into a message is kept and shown where it stood, though Graph said the message carried nothing', async () => {
    const messages = [message({ hasAttachments: false })];
    const bodies = { m1: 'Regards,\n\n\\[inline image: logo.png\\]' };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, bodies, attachments: { m1: [PASTED] } } });

    expect(files.binary.has(inlineAt('logo.png', 'sig'))).toBe(true);
    expect(files.written.get(THREAD_FILE)).toContain(`![logo.png](${shownAt('logo.png', 'sig')})`);
  });

  it('a picture shown in the body is named under inline_images, never among the attachments', async () => {
    const messages = [message({ hasAttachments: false })];
    const bodies = { m1: '\\[inline image: logo.png\\]' };
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, bodies, attachments: { m1: [PASTED] } } });
    const raw = inlineAt('logo.png', 'sig');

    // Pinned as the whole list, not by its key: a fragment cannot tell one entry from two, and a
    // file that is NOT shown leaking into this list is exactly the mistake worth catching. One
    // entry now, the picture: nothing else is written for it, its words being in the thread.
    expect(files.written.get(THREAD_FILE)).toContain(`inline_images:\n  - ${shownAt('logo.png', 'sig')}\n`);
    expect(files.written.get(THREAD_FILE)).not.toContain('attachments:\n');
    expect(outcome?.kind === 'rendered' && outcome.thread.record.inlineImages).toEqual([raw]);
  });

  // A message carrying both kinds at once: the picture is shown and listed under inline_images, the
  // document is not shown and belongs to the attachments. Only a message holding both can tell the
  // two lists apart, which is what a single-file test cannot do however exactly it is pinned.
  it('a picture shown beside a file that is not keeps each to its own list', async () => {
    const carried = [PASTED, { id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }];
    const bodies = { m1: '\\[inline image: logo.png\\]' };
    const { files } = await run({ reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, bodies, attachments: { m1: carried } } });
    const written = files.written.get(THREAD_FILE) ?? '';
    const raw = shownAt('logo.png', 'sig');

    // What FOLLOWS the list is pinned too. Without it, a file leaking in after the picture's entry
    // still satisfies a `toContain`, which is the whole mistake this test exists to catch.
    expect(written).toContain(`attachments:\n  - _attachments/Contrat.docx.md\ninline_images:\n  - ${raw}\n---`);
  });

  it('a message Graph says carries nothing, showing no picture, is never asked what it carried', async () => {
    const messages = [message({ hasAttachments: false })];
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: { m1: [PASTED] } } });

    expect(files.binary.size).toBe(0);
  });

  it('a file a message carried is named under that message, linking where it landed', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    // The card beside the thread, not the store: `shownAt` still names the store, and stays correct
    // for a picture shown in the body, which points at the image itself rather than at a card.
    expect(files.written.get(THREAD_FILE)).toContain('**Attachments:**\n- [Contrat.docx](_attachments/Contrat.docx.md) (4.0 KB, application/vnd)');
  });

  it('the list the converter closed the body with is replaced, taking its Graph id with it', async () => {
    const messages = [message({ hasAttachments: true })];
    const bodies = { m1: 'Please find it attached.\n\n**Attachments:**\n- Contrat.docx (4.0 KB, application/vnd, id: AAMkADc3NTlh==)' };
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, bodies, attachments } });
    const written = files.written.get(THREAD_FILE) ?? '';

    expect(written).not.toContain('id: AAMkADc3NTlh==');
    expect(written.split('**Attachments:**')).toHaveLength(2);
  });

  it('a file that was left alone keeps its name in the body with the reason beside it', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 4096, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(files.written.get(THREAD_FILE)).toContain('- [Demo.mp4](_attachments/Demo.mp4.md) (4.0 KB, video/mp4), a .mp4 file, which this tool does not read');
  });
});
