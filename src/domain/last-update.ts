// When the last update that finished started, kept beside the knowledge base so that an update asked
// with a max age can do nothing when one ran a short time ago. Anything that is not a time reads as no
// record: the worst a bad record can cost is one update too many.
export const serializeLastUpdate = (at: string): string => `${JSON.stringify({ at }, undefined, 2)}\n`;

export const parseLastUpdate = (text: string): string | undefined => {
  const raw = parsed(text);
  const at = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['at'] : undefined;
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : undefined;
};

// JSON.parse throws on malformed text; a pure-domain fallback (rule 17) turns that into no record.
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
