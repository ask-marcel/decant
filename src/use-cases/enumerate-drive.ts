import type { DriveDeltaPage, DriveItem } from '../domain/drive-item.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { DriveReader, DriveReaderError } from './ports/drive-reader.ts';

export type DriveSweep = {
  readonly items: ReadonlyArray<DriveItem>;
  readonly deltaLink?: string;
  readonly skipped: number;
};

const fromRoot = async (reader: DriveReader, driveId: string): Promise<Result<DriveDeltaPage, DriveReaderError>> => {
  const root = await reader.rootItemId(driveId);
  if (!root.ok) return err(root.error);
  return reader.delta({ driveId, itemId: root.value });
};

// Walks every page Graph offers, starting from the cursor the last run stored when there is one, so
// a second run reads only what changed. A cursor that comes back a second time ends the sweep: it
// would otherwise be an endless loop over the same page.
export const sweepDrive = async (reader: DriveReader, driveId: string, cursor: string | undefined): Promise<Result<DriveSweep, DriveReaderError>> => {
  const first = cursor === undefined ? await fromRoot(reader, driveId) : await reader.deltaFrom(cursor);
  if (!first.ok) return first;
  const items: DriveItem[] = [...first.value.items];
  const seen = new Set<string>();
  let skipped = first.value.skipped;
  let page = first.value;
  while (page.nextLink !== undefined && !seen.has(page.nextLink)) {
    seen.add(page.nextLink);
    const next = await reader.deltaFrom(page.nextLink);
    if (!next.ok) return next;
    items.push(...next.value.items);
    skipped += next.value.skipped;
    page = next.value;
  }
  return ok({ items, deltaLink: page.deltaLink, skipped });
};
