// Some mail carries files whose names are machine identifiers rather than words. A notification
// saying somebody shared a folder brings the icons its HTML is built from, named by the id the
// sending client gave them: `a594de8f-caa3-427e-b800-23755374d464`, 963 bytes of PNG, no extension,
// which is also why nothing reads them. The name tells a reader nothing about what it is, and when
// nothing can read the file either, there is no fact left for a card to record.
//
// Deliberately narrow. Only the canonical 8-4-4-4-12 shape, only as the WHOLE name, and at most one
// extension after it. A file somebody titled `Report a594de8f-….pdf` was named by a person who
// meant the words, and the id in it is incidental. Anything this refuses keeps its card, which is
// the safe direction to be wrong in.
const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]*)?$/i;

export const isOpaqueName = (name: string): boolean => MACHINE_ID.test(name);
