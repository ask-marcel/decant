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
const extensionOf = (name: string): string | undefined => {
  const lastDot = name.lastIndexOf('.');
  return lastDot <= 0 ? undefined : name.slice(lastDot + 1).toLowerCase();
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

export const planFile = (file: PlannedFile, maxBytes: number): FileDecision => {
  const extension = extensionOf(file.name);
  if (extension === undefined) return { kind: 'skip', reason: 'unsupported-type' };
  const route = ROUTE_BY_EXTENSION[extension];
  if (route === undefined) return { kind: 'skip', reason: 'unsupported-type' };
  if (file.size > maxBytes) return { kind: 'skip', reason: 'too-large' };
  return { kind: 'process', route, outputs: outputsFor(route, file.name) };
};
