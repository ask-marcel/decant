import { createLogger, format, transports } from 'winston';
import type { Logger } from '../use-cases/ports/logger.ts';

// Secrets plus the natural identifiers this sync handles (rule 27): mail subjects,
// bodies, participants and file names are content, never log fields.
const REDACTED_KEYS = new Set(['password', 'token', 'authorization', 'apikey', 'secret', 'email', 'phone', 'subject', 'body', 'participants', 'filename', 'path', 'weburl']);

const redactFormat = format((info) => {
  for (const key of Object.keys(info)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) info[key] = '[REDACTED]';
  }
  return info;
});

export const createWinstonLogger = (level: string): Logger => {
  const winston = createLogger({
    level,
    format: format.combine(redactFormat(), format.json()),
    transports: [new transports.Console({ stderrLevels: ['info', 'warn', 'error'] })],
  });
  return {
    info: (event, meta) => {
      winston.info(event, meta);
    },
    warn: (event, meta) => {
      winston.warn(event, meta);
    },
    error: (event, meta) => {
      winston.error(event, meta);
    },
  };
};
