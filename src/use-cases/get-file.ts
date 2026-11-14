import type { DriveItem } from '../domain/drive-item.ts';
import { libraryFolderOf, officeDocumentOf } from '../domain/get-target.ts';
import type { OfficeDocument } from '../domain/get-target.ts';
import { idHash } from '../domain/kb-path.ts';
import { skipReason } from '../domain/report.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { ConvertFile } from './convert-file.ts';
import type { DriveReader, ItemRef } from './ports/drive-reader.ts';
import type { StepError } from './ports/step-error.ts';

// One file, asked for by its address, where a sync takes a whole library. It lands under `Picked`,
// which holds no state: a folder with a state file is a synced source, and the next `update` would
// then sync the whole library the file came from.
export const PICKED_FILES = 'Picked/Files';

// The note of what was fetched, for the caller to read next.
export type Got = { readonly path: string };

export type GetFileDeps = {
  readonly drive: Pick<DriveReader, 'fromLink' | 'filesNamed' | 'item'>;
  readonly convertFile: ConvertFile;
  readonly kbRoot: string;
};

export type GetFileInput = { readonly url: string; readonly maxBytes: number };

export type GetFile = (input: GetFileInput) => Promise<Result<Got, StepError>>;

const failed = (step: string, cause: string, message: string): Result<never, StepError> => err({ step, cause, message });

// What Graph calls the top of a drive, whatever the library is named.
const ROOT_ITEM = 'root';
const HASH_LENGTH = 10;

// The site and the library, read off the address of the top of the drive, so two files of one name
// in two libraries do not land on each other. A drive whose top cannot be read still gets a folder
// of its own, named from its id.
const folderOf = async (deps: GetFileDeps, driveId: string): Promise<string> => {
  const top = await deps.drive.item({ driveId, itemId: ROOT_ITEM });
  return (top.ok ? libraryFolderOf(top.value.webUrl) : undefined) ?? `drive-${idHash(driveId).slice(0, HASH_LENGTH)}`;
};

// The markdown among what the conversion wrote, or the first file when it wrote none.
const noteOf = (outputs: ReadonlyArray<string>): string => outputs.find((path) => path.endsWith('.md')) ?? outputs[0] ?? '';

type Found = { readonly ref: ItemRef; readonly item: DriveItem };

// How many files of one name are read to find the one an Office address names.
const NAMESAKES = 25;

const NOT_FOUND = 'no file was found for this Office address: give the address from Copy link in SharePoint or OneDrive';

// The file an Office address names, among the files of its name: the one whose own address holds the
// same document id. A namesake that cannot be read is passed over, since it is not the one asked for.
const namedBy = async (deps: GetFileDeps, document: OfficeDocument): Promise<Result<Found, StepError>> => {
  const namesakes = await deps.drive.filesNamed(document.name);
  if (!namesakes.ok) return failed('resolveAddress', namesakes.error.kind, namesakes.error.message);
  for (const ref of namesakes.value.slice(0, NAMESAKES)) {
    const item = await deps.drive.item(ref);
    if (item.ok && officeDocumentOf(item.value.webUrl)?.id === document.id) return ok({ ref, item: item.value });
  }
  return failed('resolveAddress', 'not-found', NOT_FOUND);
};

// Graph resolves a sharing link and the address a file sits at. The address Office gives a document
// it does not, so that one is followed by the name and the id it carries.
const find = async (deps: GetFileDeps, url: string): Promise<Result<Found, StepError>> => {
  const ref = await deps.drive.fromLink(url);
  const document = officeDocumentOf(url);
  if (!ref.ok) return document === undefined ? failed('resolveAddress', ref.error.kind, ref.error.message) : namedBy(deps, document);
  const item = await deps.drive.item(ref.value);
  return item.ok ? ok({ ref: ref.value, item: item.value }) : failed('readFile', item.error.kind, item.error.message);
};

export const createGetFile =
  (deps: GetFileDeps): GetFile =>
  async (input) => {
    const located = await find(deps, input.url);
    if (!located.ok) return located;
    const { ref, item } = located.value;
    if (item.kind !== 'file') return failed('readFile', 'not-a-file', 'this address is a folder: give the address of one file');
    const folder = await folderOf(deps, ref.driveId);
    const outcome = await deps.convertFile({
      item,
      driveId: ref.driveId,
      site: 'Picked',
      library: folder,
      maxBytes: input.maxBytes,
      libraryRoot: `${deps.kbRoot}/${PICKED_FILES}/${folder}`,
    });
    if (outcome.kind === 'failed') return failed('convert', 'failed', outcome.reason);
    if (outcome.kind === 'skipped') return failed('convert', outcome.reason, skipReason(outcome.reason, input.maxBytes, item.name));
    return ok({ path: noteOf(outcome.outputs) });
  };
