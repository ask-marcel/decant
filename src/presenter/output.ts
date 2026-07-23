// The only sanctioned stdout writer in the repo: renderers return strings, this prints them.
// Logs go to stderr through the Logger port, so stdout stays the command's own output.
export const printLine = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
