// A markdown link destination ends at the first space unless it is wrapped in angle brackets, so
// `[Fw- DC Data -- Pepco.eml](_attachments/Fw- DC Data -- Pepco.eml.md)` renders as the literal text
// `[Fw- DC Data -- Pepco.eml](_attachments/Fw- DC Data --` followed by a link to `Pepco.eml.md`.
// Mail attachments are named by people, so spaces are the rule rather than the exception here.
//
// Parentheses end it the same way when they are unbalanced, and a name like `Budget (final).xlsx`
// is just as ordinary. Both go through the wrapped form rather than being counted and balanced.
const ENDS_A_BARE_DESTINATION = /[ ()]/;

// Inside the wrapped form it is the angle brackets that end it, and they are the one thing a
// filesystem will accept that this cannot pass through untouched.
const ANGLE = /[<>]/g;

const escaped = (path: string): string => path.replace(ANGLE, (bracket) => `\\${bracket}`);

export const linkDestination = (path: string): string => (ENDS_A_BARE_DESTINATION.test(path) ? `<${escaped(path)}>` : path);
