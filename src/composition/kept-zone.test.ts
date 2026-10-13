import { describe, expect, it } from 'bun:test';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { readKeptConfig } from './kept-zone.ts';

const INPUT = { env: {}, ocrLang: 'en', interactive: false, timezone: '', machineTimezone: 'Europe/Berlin' };

describe('the zone a knowledge base keeps', () => {
  // A run in Germany counted its days in Berlin time and one in Shanghai counts them there. Read
  // before the run is built, the kept zone makes every run count where the knowledge base does.
  it('a run counts its days in the zone its knowledge base keeps, and in its own when the knowledge base keeps none', async () => {
    const files = createFilesFake({ texts: { 'export/.decant.json': '{ "since": "2026-10-12", "timezone": "Asia/Shanghai" }' } });

    expect(await readKeptConfig({ ...INPUT, out: 'export' }, files)).toMatchObject({ kbRoot: 'export', timezone: 'Asia/Shanghai' });
    expect(await readKeptConfig({ ...INPUT, out: 'export', timezone: 'Europe/Paris' }, files)).toMatchObject({ timezone: 'Europe/Paris' });
    expect(await readKeptConfig(INPUT, files)).toMatchObject({ kbRoot: 'kb', timezone: 'Europe/Berlin' });
  });
});
