// A content address for an attachment: the SHA-256 of its bytes, hex-encoded. Two attachments with
// the same bytes resolve to the same address, which is what lets a thread convert a file its messages
// carried many times once, and the mailbox store a picture its threads showed many times once.
export const contentHash = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

// Enough of the address to name a folder in the shared store without collision inside one mailbox.
export const shortHash = (hash: string): string => hash.slice(0, 12);
