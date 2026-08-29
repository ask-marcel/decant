import { describe, expect, it } from 'bun:test';
import { parseOptions } from './options.ts';

const parse = (line: string): ReturnType<typeof parseOptions> => parseOptions(line.length === 0 ? [] : line.split(' '));

describe('reading what the operator asked for', () => {
  it('running the command with nothing else picks a source and writes for real', () => {
    expect(parse('')).toEqual({
      ok: true,
      value: {
        command: 'sync',
        driveIds: [],
        dryRun: false,
        maxSizeMb: 50,
        ocr: true,
        ocrLang: 'auto',
        concurrency: 4,
        assumeYes: false,
        mailbox: false,
        refresh: false,
        timezone: '',
      },
    });
  });

  it('a refresh can be asked for, so a site added since the last run is not waited for', () => {
    expect(parse('--refresh')).toMatchObject({ value: { refresh: true } });
  });

  it('how many items convert at once can be set, and defaults to four', () => {
    expect(parse('--concurrency 8')).toMatchObject({ value: { concurrency: 8 } });
    expect(parse('').ok && parse('')).toMatchObject({ value: { concurrency: 4 } });
  });

  it('a concurrency that is not a whole number of at least one is refused', () => {
    expect(parse('--concurrency 0')).toEqual({ ok: false, error: { kind: 'bad-option', message: '--concurrency expects a whole number of at least 1, got: 0' } });
    expect(parse('--concurrency 2.5').ok).toBe(false);
    expect(parse('--concurrency lots').ok).toBe(false);
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
    expect(parse('update --dry-run --max-size-mb 200 --ocr-lang latin --yes')).toMatchObject({
      value: { command: 'update', dryRun: true, maxSizeMb: 200, ocrLang: 'latin', assumeYes: true },
    });
  });

  it('a language RapidOCR does not have is refused here, rather than failing once per image', () => {
    const refused = parse('--ocr-lang fr');

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error.message).toContain('fr');
    expect(refused.ok === false && refused.error.message).toContain('latin');
  });

  it('letting the image choose is itself a language the operator can name', () => {
    expect(parse('--ocr-lang auto')).toMatchObject({ value: { ocrLang: 'auto' } });
  });

  it('the zone a mailbox counts its days in can be named for the run', () => {
    expect(parse('--mailbox --timezone Asia/Shanghai')).toMatchObject({ value: { timezone: 'Asia/Shanghai' } });
  });

  // The spelling a tenant reports unless it is set to IANA. Refused at the command line, because a
  // zone that names nothing would file every thread under a day counted somewhere else, in a folder
  // name that is written once and never rebuilt.
  it('the Windows spelling of a zone is refused here, rather than filing a year of threads wrongly', () => {
    const refused = parse('--timezone "China Standard Time"');

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error.message).toContain('Asia/Shanghai');
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
