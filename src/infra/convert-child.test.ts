import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerConversion } from './convert-child.ts';

const folder = mkdtempSync(join(tmpdir(), 'decant-child-'));
const path = join(folder, 'Budget.csv');
writeFileSync(path, 'Poste,Montant\nLoyer,1200\n');

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the child process that converts one file', () => {
  it('answers a conversion as JSON, and input it cannot read as a failed result', async () => {
    const answered: unknown = JSON.parse(await answerConversion(JSON.stringify({ path })));
    const unreadable: unknown = JSON.parse(await answerConversion('not json'));

    expect(answered).toMatchObject({ ok: true, value: { text: '| Poste | Montant |\n| --- | --- |\n| Loyer | 1200 |' } });
    expect(unreadable).toMatchObject({ ok: false, error: { type: 'api_error' } });
  });
});
