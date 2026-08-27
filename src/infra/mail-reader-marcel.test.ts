import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';
import { createMailReaderFromCall } from './mail-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (answers: Readonly<Partial<Record<string, Result<unknown, GraphErrorShape>>>>): { reader: ReturnType<typeof createMailReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const reader = createMailReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const answer = answers[name] ?? ok({});
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

describe('reading a mailbox through the ask-marcel library', () => {
  it('the folders of the mailbox come back with their names', async () => {
    const { reader } = readerFor({ 'list-mail-folders': ok({ value: [{ id: 'AAMk1', displayName: 'Inbox', totalItemCount: 67 }] }) });

    expect(await reader.listFolders()).toEqual({ ok: true, value: [{ id: 'AAMk1', name: 'Inbox', childCount: 0, itemCount: 67 }] });
  });

  it('the folders nested in one are asked for by its id', async () => {
    const { reader, recorded } = readerFor({ 'list-mail-child-folders': ok({ value: [] }) });

    await reader.listChildFolders('AAMk1');

    expect(recorded[0]?.params).toMatchObject({ mailFolderId: 'AAMk1' });
  });

  it('a folder sweep asks for a page size, which 2.3.0 pages through instead of truncating', async () => {
    const { reader, recorded } = readerFor({ 'list-mail-folder-messages-delta': ok({ value: [] }) });

    await reader.folderDelta('AAMk1');

    expect(recorded[0]?.params['top']).toBe('100');
    expect(recorded[0]?.params).toMatchObject({ mailFolderId: 'AAMk1' });
  });

  it('a sweep asks only for the fields the run needs', async () => {
    const { reader, recorded } = readerFor({ 'list-mail-folder-messages-delta': ok({ value: [] }) });

    await reader.folderDelta('AAMk1');

    expect(recorded[0]?.params['select']).toBe('id,conversationId,subject,receivedDateTime,hasAttachments,from,toRecipients');
  });

  it('the cursor closing a sweep comes back ready for the next run', async () => {
    const { reader } = readerFor({
      'list-mail-folder-messages-delta': ok({ value: [{ id: 'm1' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x?%24deltatoken=abc' }),
    });

    const page = await reader.folderDelta('AAMk1');

    expect(page.ok && page.value.deltaLink).toBe('https://graph.microsoft.com/v1.0/x?$deltatoken=abc');
  });

  it('a stored cursor is followed as it was handed to us', async () => {
    const { reader, recorded } = readerFor({ 'next-page': ok({ value: [] }) });

    await reader.deltaFrom('https://graph.microsoft.com/v1.0/x?$deltatoken=abc');

    expect(recorded[0]).toEqual({ name: 'next-page', params: { url: 'https://graph.microsoft.com/v1.0/x?$deltatoken=abc' } });
  });

  it('a sweep whose shape we do not know is refused clearly', async () => {
    const { reader } = readerFor({ 'list-mail-folder-messages-delta': ok({ unexpected: true }) });

    expect(await reader.folderDelta('AAMk1')).toEqual({ ok: false, error: { kind: 'permanent', message: 'mail response has no value array' } });
  });

  it('a whole conversation comes back as its messages', async () => {
    const { reader, recorded } = readerFor({ 'list-conversation-messages': ok({ value: [{ id: 'm1', conversationId: 'conv-1' }, { subject: 'no id' }] }) });

    const messages = await reader.conversation('conv-1');

    expect(messages.ok && messages.value).toHaveLength(1);
    expect(recorded[0]?.params).toMatchObject({ conversationId: 'conv-1' });
  });

  it('a message body comes back as its text', async () => {
    const { reader } = readerFor({ 'convert-mail-to-markdown': ok({ contentType: 'text/markdown', text: '**Subject:** Contrat' }) });

    expect(await reader.messageMarkdown('m1')).toEqual({ ok: true, value: '**Subject:** Contrat' });
  });

  it('what a message carried comes back with its name, size and whether it is inline', async () => {
    const { reader } = readerFor({
      'list-mail-attachments': ok({ value: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }, { name: 'no id' }] }),
    });

    expect(await reader.attachments('m1')).toEqual({
      ok: true,
      value: [{ kind: 'file', id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false, contentId: '' }],
    });
  });

  it('the content id an inline image is addressed by comes back with it', async () => {
    const { reader, recorded } = readerFor({
      'list-mail-attachments': ok({
        value: [{ id: 'att1', name: 'image931066.png', contentType: 'image/png', size: 64760, isInline: true, contentId: 'image931066.png@1B0A3865' }],
      }),
    });
    const listed = await reader.attachments('m1');

    expect(listed.ok && listed.value[0]?.contentId).toBe('image931066.png@1B0A3865');
    expect(recorded[0]?.params['select']).toContain('microsoft.graph.fileAttachment/contentId');
  });

  it('an email attached to an email is told apart from a file by what Graph calls it', async () => {
    const { reader } = readerFor({
      'list-mail-attachments': ok({
        value: [
          { '@odata.type': '#microsoft.graph.itemAttachment', id: 'att1', name: 'Customs documents MSDU1691268', size: 2764134 },
          { '@odata.type': '#microsoft.graph.referenceAttachment', id: 'att2', name: 'PROJECT UPDATES', size: 0 },
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'att3', name: 'Contrat.docx', size: 10 },
        ],
      }),
    });
    const listed = await reader.attachments('m1');

    expect(listed.ok && listed.value.map((entry) => entry.kind)).toEqual(['item', 'reference', 'file']);
  });

  it('an attachment with nothing recorded but a name still reads', async () => {
    const { reader } = readerFor({ 'list-mail-attachments': ok({ value: [{ id: 'att1', name: 'x.docx' }] }) });

    expect(await reader.attachments('m1')).toEqual({ ok: true, value: [{ kind: 'file', id: 'att1', name: 'x.docx', contentType: '', size: 0, isInline: false, contentId: '' }] });
  });

  it('an attachment converts to markdown by message and attachment together', async () => {
    const { reader, recorded } = readerFor({ 'convert-mail-attachment-to-markdown': ok({ text: '# Contrat' }) });

    expect(await reader.attachmentMarkdown('m1', 'att1')).toEqual({ ok: true, value: '# Contrat' });
    expect(recorded[0]?.params).toEqual({ messageId: 'm1', attachmentId: 'att1', includeMetadata: 'true' });
  });

  it('an attachment rendered to PDF comes back as bytes', async () => {
    const { reader } = readerFor({ 'convert-mail-attachment-to-pdf': ok({ base64: Buffer.from('%PDF-1.7').toString('base64') }) });

    const rendered = await reader.attachmentPdf('m1', 'att1');

    expect(rendered.ok && new TextDecoder().decode(rendered.value)).toBe('%PDF-1.7');
  });

  it('an attachment fetched whole comes back as bytes', async () => {
    const { reader } = readerFor({ 'get-mail-attachment': ok({ base64: Buffer.from('raw').toString('base64') }) });

    const fetched = await reader.attachmentBytes('m1', 'att1');

    expect(fetched.ok && new TextDecoder().decode(fetched.value)).toBe('raw');
  });

  it('an attachment handed back as text is still usable as bytes', async () => {
    const { reader } = readerFor({ 'get-mail-attachment': ok({ text: 'plain note' }) });

    const fetched = await reader.attachmentBytes('m1', 'att1');

    expect(fetched.ok && new TextDecoder().decode(fetched.value)).toBe('plain note');
  });

  it('an attachment that carried no content at all is reported', async () => {
    const { reader } = readerFor({ 'get-mail-attachment': ok({ contentType: 'application/pdf' }) });

    expect(await reader.attachmentBytes('m1', 'att1')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph returned no bytes' } });
  });

  it('the SharePoint files a mail points at come back resolved', async () => {
    const links = {
      links: [
        { url: 'https://x', driveId: 'b!one', itemId: '01ABC', name: 'Rapport.docx' },
        { url: 'https://y', error: 'not found' },
      ],
    };
    const { reader } = readerFor({ 'extract-sharepoint-links-in-mail': ok(links) });

    expect(await reader.sharepointLinks('m1')).toEqual({ ok: true, value: [{ url: 'https://x', driveId: 'b!one', itemId: '01ABC', name: 'Rapport.docx' }] });
  });

  it('a mail pointing at nothing yields nothing', async () => {
    const { reader } = readerFor({ 'extract-sharepoint-links-in-mail': ok({ messageId: 'm1' }) });

    expect(await reader.sharepointLinks('m1')).toEqual({ ok: true, value: [] });
  });

  it('a refusal from Graph is passed straight back to the run', async () => {
    const { reader } = readerFor({ 'list-mail-folders': err({ type: 'auth_failed', message: 'not authenticated' }) });

    expect((await reader.listFolders()).ok).toBe(false);
  });
});
