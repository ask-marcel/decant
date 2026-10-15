import type { DriveReaderError } from './ports/drive-reader.ts';

// What Graph answers a delta cursor whose sync state it no longer keeps: a mail folder's, a library's
// or a calendar's. The cursor is worth nothing then, and only a read from the start brings the source
// back.
const EXPIRED = 410;

export const expiredCursor = (error: DriveReaderError): boolean => error.kind === 'permanent' && error.status === EXPIRED;
