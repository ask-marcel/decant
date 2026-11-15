import type { DriveReaderError } from './ports/drive-reader.ts';

// The HTTP status Graph answered with. Only a permanent refusal carries one, so any other reads as
// none.
const statusOf = (error: DriveReaderError): number | undefined => ({ status: undefined, ...error }).status;

// What Graph answers a delta cursor whose sync state it no longer keeps: a mail folder's, a library's
// or a calendar's. The cursor is worth nothing then, and only a read from the start brings the source
// back.
const EXPIRED = 410;

export const expiredCursor = (error: DriveReaderError): boolean => statusOf(error) === EXPIRED;

// What Graph answers for an item it does not have: deleted, or moved out of the library.
const NOT_FOUND = 404;

export const notFound = (error: DriveReaderError): boolean => statusOf(error) === NOT_FOUND;

// What Graph answers for a request it will not run as it was asked: an id of one kind given where
// an id of another kind goes is one of these.
const BAD_REQUEST = 400;

export const badRequest = (error: DriveReaderError): boolean => statusOf(error) === BAD_REQUEST;
