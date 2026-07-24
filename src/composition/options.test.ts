import { describe, expect, it } from 'bun:test';
import { parseOptions } from './options.ts';

const parse = (line: string): ReturnType<typeof parseOptions> => parseOptions(line.length === 0 ? [] : line.split(' '));

describe('reading what the operator asked for', () => {
  it('running the command with nothing else picks a source and writes for real', () => {
    expect(parse('')).toEqual({
      ok: true,
      value: { command: 'sync', driveIds: [], dryRun: false, maxSizeMb: 50, ocr: true, ocrLang: 'en', assumeYes: false, mailbox: false },
    });
  });

  it('the mailbox can be named outright, so the picker is not shown', () => {
    expect(parse('--mailbox')).toMatchObject({ value: { mailbox: true } });
  });

  it('a mailbox run can be narrowed to conversations since a given day', () => {
    expect(parse('--mailbox --since 2026-01-31')).toMatchObject({ value: { mailbox: true, since: '2026-01-31' } });
  });

  it('a day that is not a day is refused rather than silently syncing everything', () => {
    expect(parse('--since last-week')).toEqual({ ok: false, error: { kind: 'bad-option', message: '--since expects a day like 2026-01-31, got: last-week' } });
    expect(parse('--since 2026-01-31T00:00:00Z').ok).toBe(false);
  });

  it('the update command asks nothing and refreshes what is already there', () => {
    expect(parse('update').ok && parse('update')).toMatchObject({ value: { command: 'update' } });
  });

  it('a site can be named outright, so the picker is not shown', () => {
    expect(parse('--site-id contoso,1,2')).toMatchObject({ value: { siteId: 'contoso,1,2' } });
  });

  it('a site can be given by address, for the ones the search index does not list', () => {
    expect(parse('--site-url https://tenant.sharepoint.com/sites/X')).toMatchObject({ value: { siteUrl: 'https://tenant.sharepoint.com/sites/X' } });
  });

  it('several libraries can be named, and each one is kept', () => {
    expect(parse('--drive-id b!one --drive-id b!two')).toMatchObject({ value: { driveIds: ['b!one', 'b!two'] } });
  });

  it('a dry run, a size cap, a language and the saved choices can be set together', () => {
    expect(parse('update --dry-run --max-size-mb 200 --ocr-lang fr --yes')).toMatchObject({
      value: { command: 'update', dryRun: true, maxSizeMb: 200, ocrLang: 'fr', assumeYes: true },
    });
  });

  it('reading images can be turned off for a run', () => {
    expect(parse('--no-ocr')).toMatchObject({ value: { ocr: false } });
  });

  it('an option nobody recognises is refused with its name', () => {
    expect(parse('--turbo')).toEqual({ ok: false, error: { kind: 'bad-option', message: 'unknown option: --turbo' } });
  });

  it('a stray word is refused rather than taken for a source', () => {
    expect(parse('everything')).toEqual({ ok: false, error: { kind: 'bad-option', message: 'unexpected argument: everything' } });
  });

  it('an option missing its value is refused rather than silently ignored', () => {
    expect(parse('--site-id')).toEqual({ ok: false, error: { kind: 'bad-option', message: '--site-id expects a value' } });
  });

  it('a size cap that is not a positive number is refused', () => {
    expect(parse('--max-size-mb zero')).toEqual({ ok: false, error: { kind: 'bad-option', message: '--max-size-mb expects a positive number, got: zero' } });
    expect(parse('--max-size-mb -5').ok).toBe(false);
  });
});
