import { describe, expect, it } from 'bun:test';
import { cutDataPictures } from './data-pictures.ts';

const FOLDER = './Contrat.docx.media';

const bytesOf = (cut: ReturnType<typeof cutDataPictures>): ReadonlyArray<{ name: string; bytes: ReadonlyArray<number> }> =>
  cut.pictures.map((picture) => ({ name: picture.name, bytes: [...picture.bytes] }));

describe('the pictures a Word document holds in its text', () => {
  // The library gives each picture where the document shows it, as base64 in a `data:` link: a page
  // of text around a few photos weighs megabytes, and no viewer shows the picture in a table cell.
  it('each picture goes to a numbered file, and the text links to that file where the picture stood', () => {
    const cut = cutDataPictures('Intro\n\n![Org chart](data:image/png;base64,AQID)\n\n| Site | ![](data:image/jpeg;base64,BAUG) |', FOLDER);

    expect(cut.text).toBe('Intro\n\n![Org chart](./Contrat.docx.media/image-01.png)\n\n| Site | ![image-02.jpeg](./Contrat.docx.media/image-02.jpeg) |');
    expect(bytesOf(cut)).toEqual([
      { name: 'image-01.png', bytes: [1, 2, 3] },
      { name: 'image-02.jpeg', bytes: [4, 5, 6] },
    ]);
  });

  it('a picture the text shows twice is one file, linked from both places', () => {
    const cut = cutDataPictures('![Logo](data:image/png;base64,AQID) and ![Logo again](data:image/png;base64,AQID)', FOLDER);

    expect(cut.text).toBe('![Logo](./Contrat.docx.media/image-01.png) and ![Logo again](./Contrat.docx.media/image-01.png)');
    expect(bytesOf(cut)).toEqual([{ name: 'image-01.png', bytes: [1, 2, 3] }]);
  });

  // Word keeps a drawing as EMF or WMF, and a picture of a type the document does not name has no
  // extension rather than a wrong one.
  it('each file takes the extension of its type', () => {
    const types = ['image/x-emf', 'image/x-wmf', 'image/svg+xml', 'IMAGE/GIF', 'null', 'image/'];
    const cut = cutDataPictures(types.map((type, at) => `![](data:${type};base64,AQI${'ABCDEF'[at] ?? ''})`).join(' '), FOLDER);

    expect(cut.pictures.map((picture) => picture.name)).toEqual(['image-01.emf', 'image-02.wmf', 'image-03.svg', 'image-04.gif', 'image-05', 'image-06']);
  });

  // What the library writes: each bracket of an alt text escaped, the line break of Word's own alt text
  // kept, and base64 with `+` and `/`.
  it('a picture whose alt text holds brackets or a line break goes to its file as well', () => {
    const cut = cutDataPictures('![Logo \\[Contoso\\]](data:image/png;base64,+/8=) ![A screenshot\nDescription automatically generated](data:image/png;base64,AQID)', FOLDER);

    expect(cut.text).toBe('![Logo \\[Contoso\\]](./Contrat.docx.media/image-01.png) ![A screenshot\nDescription automatically generated](./Contrat.docx.media/image-02.png)');
    expect(bytesOf(cut)).toEqual([
      { name: 'image-01.png', bytes: [251, 255] },
      { name: 'image-02.png', bytes: [1, 2, 3] },
    ]);
  });

  it('a folder whose name holds a space is linked in the form a viewer follows past the space', () => {
    expect(cutDataPictures('![](data:image/png;base64,AQID)', './ASN Spec.docx.media').text).toBe('![image-01.png](<./ASN Spec.docx.media/image-01.png>)');
  });

  // The library writes `[image: <alt>]` for a picture it does not give, and this is the same reading.
  it('a picture whose base64 does not read is the placeholder the library writes in its place', () => {
    const cut = cutDataPictures('![Logo](data:image/png;base64,A) then ![](data:image/png;base64,AQ==AQ==)', FOLDER);

    expect(cut.text).toBe('[image: Logo] then [image]');
    expect(cut.pictures).toStrictEqual([]);
  });

  it('a picture that is not base64 in the text stays as it was', () => {
    const text = ['![Site](https://contoso.example/logo.png)', '![Local](./logo.png)', '![Raw](data:image/svg+xml,<svg/>)', '![Empty](data:image/png;base64,)'].join('\n');
    const cut = cutDataPictures(text, FOLDER);

    expect(cut.text).toBe(text);
    expect(cut.pictures).toStrictEqual([]);
  });
});
