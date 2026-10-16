import { describe, expect, it } from 'bun:test';
import { namedForBytes, namedForType } from './file-kind.ts';

const bytes = (...values: ReadonlyArray<number>): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('naming a file by what it is', () => {
  it('a name with no extension takes the one its content type goes by, parameters and letter case aside', () => {
    expect(namedForType('Scan', 'image/jpeg')).toBe('Scan.jpg');
    expect(namedForType('Contract', 'Application/PDF; name="Contract"')).toBe('Contract.pdf');
    expect(namedForType('Budget', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('Budget.xlsx');
  });

  it('a name with an extension, a kind with none known, and a machine id keep the name they have', () => {
    expect(namedForType('Scan.png', 'image/jpeg')).toBe('Scan.png');
    expect(namedForType('Scan', 'application/octet-stream')).toBe('Scan');
    expect(namedForType('a594de8f-caa3-427e-b800-23755374d464', 'image/png')).toBe('a594de8f-caa3-427e-b800-23755374d464');
  });

  it('a picture whose first bytes say another kind takes the extension of what it is', () => {
    expect(namedForBytes('logo.png', ascii('GIF89a and the rest'))).toBe('logo.gif');
    expect(namedForBytes('photo.gif', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('photo.jpg');
    expect(namedForBytes('chart.jpg', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe('chart.png');
    expect(namedForBytes('scan.png', ascii('BM6 and the rest'))).toBe('scan.bmp');
    expect(namedForBytes('scan.png', bytes(0x49, 0x49, 0x2a, 0x00))).toBe('scan.tif');
    expect(namedForBytes('scan.png', bytes(0x4d, 0x4d, 0x00, 0x2a))).toBe('scan.tif');
    expect(namedForBytes('icon.png', ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('icon.webp');
  });

  it('a picture whose bytes agree with its name, by any of its names, keeps it, and so does anything not a picture', () => {
    expect(namedForBytes('photo.jpeg', bytes(0xff, 0xd8, 0xff, 0xe1))).toBe('photo.jpeg');
    expect(namedForBytes('scan.tiff', bytes(0x49, 0x49, 0x2a, 0x00))).toBe('scan.tiff');
    expect(namedForBytes('logo.PNG', bytes(0x89, 0x50, 0x4e, 0x47))).toBe('logo.PNG');
    expect(namedForBytes('Contract.pdf', ascii('GIF89a'))).toBe('Contract.pdf');
    expect(namedForBytes('logo.png', ascii('RIFF....WAVE'))).toBe('logo.png');
    expect(namedForBytes('logo.png', bytes(0x89))).toBe('logo.png');
    expect(namedForBytes('logo', ascii('GIF89a'))).toBe('logo');
  });
});
