// What a file found in SharePoint turns into on disk. Purely a decision: the route names how the
// bytes are obtained, the outputs name every file the sync will write for it.
export type ConversionRoute = 'document' | 'slides' | 'legacy-slides' | 'pdf' | 'archive' | 'image' | 'vector';

export type OutputRole = 'markdown' | 'pdf' | 'raw' | 'archive-folder';

export type PlannedOutput = { readonly relName: string; readonly role: OutputRole };

export type FileDecision =
  | { readonly kind: 'skip'; readonly reason: 'unsupported-type' | 'too-large' }
  | { readonly kind: 'process'; readonly route: ConversionRoute; readonly outputs: ReadonlyArray<PlannedOutput> };

export type PlannedFile = { readonly name: string; readonly size: number };

// Partial, because the key set is open: any extension not listed here is one we do not handle.
// A Loop page (`.loop`, and the same page under its older `.fluid` name, and a `.whiteboard`) holds
// no body of its own: the text lives in the Fluid service and Graph renders it on request. It is a
// document all the same, because the reader asks Graph for that rendering and hands back markdown.
const ROUTE_BY_EXTENSION: Readonly<Partial<Record<string, ConversionRoute>>> = {
  csv: 'document',
  doc: 'document',
  docm: 'document',
  docx: 'document',
  fluid: 'document',
  htm: 'document',
  html: 'document',
  json: 'document',
  log: 'document',
  loop: 'document',
  md: 'document',
  msg: 'document',
  odp: 'document',
  ods: 'document',
  odt: 'document',
  // A SARIF report is JSON, which the converter already passes through as text.
  sarif: 'document',
  txt: 'document',
  whiteboard: 'document',
  xls: 'document',
  xlsm: 'document',
  xlsx: 'document',
  xml: 'document',
  yaml: 'document',
  yml: 'document',
  pptm: 'slides',
  pptx: 'slides',
  ppt: 'legacy-slides',
  rtf: 'legacy-slides',
  pdf: 'pdf',
  zip: 'archive',
  bmp: 'image',
  gif: 'image',
  heic: 'image',
  jpeg: 'image',
  jpg: 'image',
  png: 'image',
  tif: 'image',
  tiff: 'image',
  webp: 'image',
  svg: 'vector',
};

// A leading dot names a hidden file, so `.docx` has no extension: it is a file called `.docx`.
// Outlook does not clean an attachment name the way SharePoint does, so `Budget.xlsx ` arrives with
// its space and would name a kind nothing handles. Trimmed here rather than at every call, the way
// `safeSegment` already trims the name it writes to disk.
const extensionOf = (name: string): string | undefined => {
  const lastDot = name.lastIndexOf('.');
  const found = lastDot <= 0 ? '' : name.slice(lastDot + 1).trim();
  return found.length === 0 ? undefined : found.toLowerCase();
};

// Only ever called for a route that was matched by extension, so a dot is guaranteed.
const withoutExtension = (name: string): string => name.slice(0, name.lastIndexOf('.'));

const outputsFor = (route: ConversionRoute, name: string): ReadonlyArray<PlannedOutput> => {
  if (route === 'slides')
    return [
      { relName: `${name}.md`, role: 'markdown' },
      { relName: `${name}.pdf`, role: 'pdf' },
    ];
  if (route === 'legacy-slides')
    return [
      { relName: `${name}.pdf`, role: 'pdf' },
      { relName: `${name}.md`, role: 'markdown' },
    ];
  if (route === 'archive') return [{ relName: withoutExtension(name), role: 'archive-folder' }];
  if (route === 'document') return [{ relName: `${name}.md`, role: 'markdown' }];
  return [
    { relName: name, role: 'raw' },
    { relName: `${name}.md`, role: 'markdown' },
  ];
};

// The kinds whose pictures are worth taking out of them: only the ones that keep no copy you can
// look at. A Word or Excel file is converted to text alone, so a diagram inside it survives nowhere
// else. A PDF is written beside its markdown and a deck is rendered to one, so their pictures are
// already on disk in openable form; pulling them out again duplicates what is there and costs the
// most where it buys the least (one 14 MB manual answered with 172 images, tens of minutes of
// reading). The legacy binary formats are refused by the source, so asking spends a round trip to
// be told no, and a plain-text kind has nothing embedded to ask about at all.
const EMBEDS_IMAGES: ReadonlySet<string> = new Set(['docm', 'docx', 'xlsm', 'xlsx']);

export const embedsImages = (name: string): boolean => {
  const extension = extensionOf(name);
  return extension !== undefined && EMBEDS_IMAGES.has(extension);
};

export const planFile = (file: PlannedFile, maxBytes: number): FileDecision => {
  const extension = extensionOf(file.name);
  if (extension === undefined) return { kind: 'skip', reason: 'unsupported-type' };
  const route = ROUTE_BY_EXTENSION[extension];
  if (route === undefined) return { kind: 'skip', reason: 'unsupported-type' };
  if (file.size > maxBytes) return { kind: 'skip', reason: 'too-large' };
  return { kind: 'process', route, outputs: outputsFor(route, file.name) };
};
