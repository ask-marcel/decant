import { describe, expect, it } from 'bun:test';
import type { MessageHeader } from './root-message-id.ts';
import { rootMessageId } from './root-message-id.ts';

const header = (name: string, value: string): MessageHeader => ({ name, value });

const OWN = '<AS4PR05MB9618@outlook.com>';
const ROOT = '<FRRPR05MB13141@outlook.com>';

describe('deciding which message a thread began with', () => {
  it('a reply names the message its thread began with', () => {
    expect(rootMessageId([header('References', ROOT)], OWN)).toBe(ROOT);
  });

  it('the header is found however the server cased its name', () => {
    expect(rootMessageId([header('references', ROOT)], OWN)).toBe(ROOT);
  });

  it('a chain of references answers with the message it started from, not the last one', () => {
    expect(rootMessageId([header('References', `${ROOT} <middle@outlook.com>`)], OWN)).toBe(ROOT);
  });

  it('a reference list folded across lines still names one message', () => {
    expect(rootMessageId([header('References', `\r\n ${ROOT}\r\n <middle@outlook.com>`)], OWN)).toBe(ROOT);
  });

  // The id it carries, not the one Graph filed it under: asserting against `OWN` would pass even if
  // the header were never read, since the fallback answers with `OWN` too.
  it('a message that began a thread is named by the id it carries, not the one Graph filed it under', () => {
    expect(rootMessageId([header('Message-ID', ROOT)], OWN)).toBe(ROOT);
  });

  it('a message whose headers say nothing falls back to the id Graph gave it', () => {
    expect(rootMessageId([], OWN)).toBe(OWN);
  });

  it('a reference that is not a message id at all is passed over', () => {
    expect(rootMessageId([header('References', 'not an id')], OWN)).toBe(OWN);
  });

  it('a header of another name is never mistaken for the thread root', () => {
    expect(rootMessageId([header('In-Reply-To', ROOT)], OWN)).toBe(OWN);
  });
});
