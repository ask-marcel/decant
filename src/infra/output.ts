// Everything printed here can carry text this tool did not write: a site or file name from Graph, or
// the operator's own answer echoed back in a refusal. A terminal reads control characters as commands,
// so an escape sequence in that text moves the cursor and overwrites what was already on screen,
// which is how an error message ends up hiding itself. Dropping them is the checkpoint in front of
// the terminal, the way `kb-path.ts` is the one in front of the filesystem.
const TAB = 0x09;
const NEWLINE = 0x0a;
const FIRST_PRINTABLE = 0x20;
const DEL = 0x7f;
const LAST_C1 = 0x9f;

// Tab and newline are how a renderer lays a block out, so they stay. The rest of C0, DEL and the C1
// range are commands rather than text. Every printable character is kept, in any script, so a name
// like 工作组网站 prints as itself.
const isPrintable = (char: string): boolean => {
  const code = char.codePointAt(0) ?? FIRST_PRINTABLE;
  if (code === TAB || code === NEWLINE) return true;
  return code >= FIRST_PRINTABLE && code !== DEL && !(code > DEL && code <= LAST_C1);
};

const forTerminal = (text: string): string => [...text].filter(isPrintable).join('');

// The only sanctioned stdout writer in the repo: renderers return strings, this prints them.
// Logs go to stderr through the Logger port, so stdout stays the command's own output.
export const printLine = (text: string): void => {
  process.stdout.write(`${forTerminal(text)}\n`);
};
