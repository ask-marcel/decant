import { describe, expect, it } from 'bun:test';
import type { ConversionRoute } from './conversion-plan.ts';
import { embedsImages, planFile } from './conversion-plan.ts';

const CAP = 50 * 1024 * 1024;

// The formats this tool claims to handle, and how each is obtained. Changing a row changes what a
// user gets out of a library, so the whole table is pinned rather than a sample of it.
const SUPPORTED: ReadonlyArray<readonly [string, ConversionRoute]> = [
  ['csv', 'document'],
  ['doc', 'document'],
  ['docm', 'document'],
  ['docx', 'document'],
  ['htm', 'document'],
  ['html', 'document'],
  ['json', 'document'],
  ['log', 'document'],
  ['md', 'document'],
  ['msg', 'document'],
  ['odp', 'document'],
  ['ods', 'document'],
  ['odt', 'document'],
  ['sarif', 'document'],
  ['txt', 'document'],
  ['xls', 'document'],
  ['xlsm', 'document'],
  ['xlsx', 'document'],
  ['xml', 'document'],
  ['yaml', 'document'],
  ['yml', 'document'],
  ['loop', 'document'],
  ['fluid', 'document'],
  ['whiteboard', 'document'],
  ['pptm', 'slides'],
  ['pptx', 'slides'],
  ['ppt', 'legacy-slides'],
  ['rtf', 'legacy-slides'],
  ['pdf', 'pdf'],
  ['zip', 'archive'],
  ['bmp', 'image'],
  ['gif', 'image'],
  ['heic', 'image'],
  ['jpeg', 'image'],
  ['jpg', 'image'],
  ['png', 'image'],
  ['tif', 'image'],
  ['tiff', 'image'],
  ['webp', 'image'],
  ['svg', 'vector'],
];

describe('the formats this tool handles', () => {
  for (const [extension, route] of SUPPORTED) {
    it(`a .${extension} file is handled as ${route}`, () => {
      const decision = planFile({ name: `Document.${extension}`, size: 10 }, CAP);

      expect(decision.kind === 'process' && decision.route).toBe(route);
    });
  }
});

describe('deciding what to produce for a document found in SharePoint', () => {
  it('a Word document becomes a single markdown file beside its name', () => {
    expect(planFile({ name: 'Contrat.docx', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'document',
      outputs: [{ relName: 'Contrat.docx.md', role: 'markdown' }],
    });
  });

  it('a spreadsheet is treated as a document, one markdown table per sheet', () => {
    expect(planFile({ name: 'Budget.xlsx', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'document',
      outputs: [{ relName: 'Budget.xlsx.md', role: 'markdown' }],
    });
  });

  it('a saved email is treated as a document', () => {
    expect(planFile({ name: 'Echange.msg', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'document',
      outputs: [{ relName: 'Echange.msg.md', role: 'markdown' }],
    });
  });

  it('a deck becomes markdown for the text and a PDF so an agent can see the slides', () => {
    expect(planFile({ name: 'Roadmap.pptx', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'slides',
      outputs: [
        { relName: 'Roadmap.pptx.md', role: 'markdown' },
        { relName: 'Roadmap.pptx.pdf', role: 'pdf' },
      ],
    });
  });

  it('a deck in the 97-2003 format is rendered to PDF first, since nothing reads it directly', () => {
    expect(planFile({ name: 'Vieux.ppt', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'legacy-slides',
      outputs: [
        { relName: 'Vieux.ppt.pdf', role: 'pdf' },
        { relName: 'Vieux.ppt.md', role: 'markdown' },
      ],
    });
  });

  it('a PDF is kept as it is and given a markdown companion holding its text', () => {
    expect(planFile({ name: 'Contrat.pdf', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'pdf',
      outputs: [
        { relName: 'Contrat.pdf', role: 'raw' },
        { relName: 'Contrat.pdf.md', role: 'markdown' },
      ],
    });
  });

  it('an archive becomes a folder, its contents planned once unpacked', () => {
    expect(planFile({ name: 'Livraison.zip', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'archive',
      outputs: [{ relName: 'Livraison', role: 'archive-folder' }],
    });
  });

  it('a photo is kept as it is and given a markdown companion for its recognised text', () => {
    expect(planFile({ name: 'Tableau blanc.JPG', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'image',
      outputs: [
        { relName: 'Tableau blanc.JPG', role: 'raw' },
        { relName: 'Tableau blanc.JPG.md', role: 'markdown' },
      ],
    });
  });

  it('a vector drawing is kept as it is, with a markdown note pointing at the file', () => {
    expect(planFile({ name: 'Logo.svg', size: 1000 }, CAP)).toEqual({
      kind: 'process',
      route: 'vector',
      outputs: [
        { relName: 'Logo.svg', role: 'raw' },
        { relName: 'Logo.svg.md', role: 'markdown' },
      ],
    });
  });

  it('a video is left in SharePoint and only reported', () => {
    expect(planFile({ name: 'Demo.mp4', size: 1000 }, CAP)).toEqual({ kind: 'skip', reason: 'unsupported-type' });
  });

  it('a file with no extension at all is left in SharePoint and only reported', () => {
    expect(planFile({ name: 'LISEZMOI', size: 1000 }, CAP)).toEqual({ kind: 'skip', reason: 'unsupported-type' });
  });

  it('a hidden file whose whole name looks like an extension is not mistaken for a document', () => {
    expect(planFile({ name: '.docx', size: 1000 }, CAP)).toEqual({ kind: 'skip', reason: 'unsupported-type' });
  });

  it('a convertible file above the size cap is skipped so one document cannot stall the run', () => {
    expect(planFile({ name: 'Enorme.pptx', size: CAP + 1 }, CAP)).toEqual({ kind: 'skip', reason: 'too-large' });
  });

  it('a file exactly at the size cap is still processed', () => {
    expect(planFile({ name: 'Juste.docx', size: CAP }, CAP).kind).toBe('process');
  });

  it('an unsupported file is reported as unsupported even when it is also oversized', () => {
    expect(planFile({ name: 'Enorme.mp4', size: CAP + 1 }, CAP)).toEqual({ kind: 'skip', reason: 'unsupported-type' });
  });
});

// Which kinds are asked for the pictures inside them. Asking costs a round trip, so the row for a
// kind that would only be refused matters as much as the row for one that answers.
const EMBEDS: ReadonlyArray<readonly [string, boolean]> = [
  ['docx', true],
  ['docm', true],
  ['xlsx', true],
  ['xlsm', true],
  ['pptx', true],
  ['pptm', true],
  ['pdf', true],
  ['doc', false],
  ['xls', false],
  ['ppt', false],
  ['txt', false],
  ['csv', false],
  ['png', false],
  ['Makefile', false],
];

describe('which documents are asked for the pictures inside them', () => {
  for (const [name, expected] of EMBEDS) {
    it(`a ${name} ${expected ? 'is' : 'is not'} asked for the pictures inside it`, () => {
      expect(embedsImages(name.includes('.') || name === 'Makefile' ? name : `Document.${name}`)).toBe(expected);
    });
  }
});
