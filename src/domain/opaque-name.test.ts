import { describe, expect, it } from 'bun:test';
import { isOpaqueName } from './opaque-name.ts';

describe('telling a name that says nothing from one that says something', () => {
  it('a bare machine id says nothing, being what a client names an icon it generated', () => {
    expect(isOpaqueName('a594de8f-caa3-427e-b800-23755374d464')).toBe(true);
  });

  it('an extension does not rescue it, since the kind of file was never the question', () => {
    expect(isOpaqueName('212baa7c-b808-4073-9b1d-40bf89385240.png')).toBe(true);
  });

  it('the same id in capitals says as little, mail clients differing on the case they write', () => {
    expect(isOpaqueName('A594DE8F-CAA3-427E-B800-23755374D464')).toBe(true);
  });

  it('a name somebody chose says something, however dull', () => {
    expect(isOpaqueName('Container Event.xlsx')).toBe(false);
  });

  it('a name that merely carries an id still says something, the words around it being the point', () => {
    expect(isOpaqueName('Report a594de8f-caa3-427e-b800-23755374d464.pdf')).toBe(false);
  });

  it('a run of hex in the wrong shape is not an id, and nothing licenses dropping it', () => {
    expect(isOpaqueName('a594de8f-caa3-427e-b800-23755374d46')).toBe(false);
  });

  it('a hidden file is named, not identified, whatever follows its leading dot', () => {
    expect(isOpaqueName('.gitignore')).toBe(false);
  });

  it('an id with anything appended is no longer one, and something appended it on purpose', () => {
    expect(isOpaqueName('a594de8f-caa3-427e-b800-23755374d464-thumb')).toBe(false);
  });

  it('a name of nothing at all says nothing, and there is no reader it could help', () => {
    expect(isOpaqueName('')).toBe(false);
  });
});
