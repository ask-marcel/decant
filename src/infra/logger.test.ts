import { afterEach, describe, expect, it } from 'bun:test';
import { createWinstonLogger } from './logger.ts';

const originalWrite = process.stderr.write.bind(process.stderr);
let written: string[] = [];

const captureStderr = (): void => {
  written = [];
  process.stderr.write = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
};

const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  process.stderr.write = originalWrite;
});

describe('logging what the sync is doing', () => {
  it('an event logged at each level reaches stderr, leaving stdout for command output', async () => {
    captureStderr();
    const logger = createWinstonLogger('info');

    logger.info('sync.started');
    logger.warn('file.skipped');
    logger.error('file.failed');
    await settle();

    expect(written.join('')).toContain('sync.started');
    expect(written.join('')).toContain('file.skipped');
    expect(written.join('')).toContain('file.failed');
  });

  it('a file name attached to an event is redacted so content never leaks into logs', async () => {
    captureStderr();
    const logger = createWinstonLogger('info');

    logger.info('file.converted', { filename: 'Contrat confidentiel.docx', itemId: '01ABC' });
    await settle();

    expect(written.join('')).not.toContain('Contrat confidentiel.docx');
    expect(written.join('')).toContain('[REDACTED]');
    expect(written.join('')).toContain('01ABC');
  });

  it('an event below the configured level is not written at all', async () => {
    captureStderr();
    const logger = createWinstonLogger('error');

    logger.info('sync.started');
    await settle();

    expect(written.join('')).toBe('');
  });
});
