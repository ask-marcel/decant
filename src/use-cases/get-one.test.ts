import { describe, expect, it } from 'bun:test';
import { ok } from '../domain/result.ts';
import { createGetOne } from './get-one.ts';
import type { GetFileInput } from './get-file.ts';
import type { GetMailInput } from './get-mail.ts';

const getter = (): { getOne: ReturnType<typeof createGetOne>; files: GetFileInput[]; mails: GetMailInput[] } => {
  const files: GetFileInput[] = [];
  const mails: GetMailInput[] = [];
  const getOne = createGetOne({
    getFile: async (input) => {
      files.push(input);
      return ok({ path: 'kb/Picked/Files/x.md' });
    },
    getMail: async (input) => {
      mails.push(input);
      return ok({ path: 'kb/Picked/Mailbox/x.md' });
    },
  });
  return { getOne, files, mails };
};

describe('getting the one thing that was asked for', () => {
  it('the address of a file is fetched as a file, with the size limit of the run', async () => {
    const { getOne, files, mails } = getter();

    const got = await getOne({ target: { kind: 'file', url: 'https://contoso.sharepoint.com/x.docx' }, maxBytes: 1000 });

    expect(got).toEqual({ ok: true, value: { path: 'kb/Picked/Files/x.md' } });
    expect(files).toEqual([{ url: 'https://contoso.sharepoint.com/x.docx', maxBytes: 1000 }]);
    expect(mails).toHaveLength(0);
  });

  it('the id of a mail, and the address of one, are fetched as a conversation', async () => {
    const { getOne, files, mails } = getter();

    const got = await getOne({ target: { kind: 'mail', id: 'AAMkAGI=' }, maxBytes: 1000 });
    await getOne({ target: { kind: 'mail-link', url: 'https://outlook.office.com/mail/x' }, maxBytes: 1000 });

    expect(got).toEqual({ ok: true, value: { path: 'kb/Picked/Mailbox/x.md' } });
    expect(mails.map((mail) => mail.target.kind)).toEqual(['mail', 'mail-link']);
    expect(files).toHaveLength(0);
  });
});
