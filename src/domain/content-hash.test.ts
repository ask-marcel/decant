import { describe, expect, it } from 'bun:test';
import { contentHash, shortHash } from './content-hash.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('addressing an attachment by its content', () => {
  it('the same bytes always resolve to the same address', () => {
    expect(contentHash(bytes('the contract'))).toBe(contentHash(bytes('the contract')));
  });

  it('different bytes resolve to different addresses', () => {
    expect(contentHash(bytes('contract A'))).not.toBe(contentHash(bytes('contract B')));
  });

  it('the address is the SHA-256 hex of the bytes', () => {
    // The NIST test vector: `printf abc | sha256sum`.
    expect(contentHash(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('the short form is the first twelve hex characters, enough to name a folder', () => {
    expect(shortHash(contentHash(bytes('abc')))).toBe('ba7816bf8f01');
  });
});
