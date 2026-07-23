import { describe, expect, it } from 'bun:test';
import { parseJson } from './parse-json.ts';

describe('reading JSON written by a previous run', () => {
  it('well-formed JSON is handed back as data', () => {
    expect(parseJson('{"version":1}')).toEqual({ ok: true, value: { version: 1 } });
  });

  it('a truncated file is reported as invalid JSON instead of throwing', () => {
    const parsed = parseJson('{"version":');

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error.kind).toBe('invalid-json');
  });
});
