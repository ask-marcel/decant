// One order on every machine. `localeCompare` with no locale sorts by the language the machine is
// set to, so the same list came out in another order from a laptop set to another language, and
// each file holding it changed for nothing. Built once: a collator is costly to make.
const ORDER = new Intl.Collator('en');

export const compareText = (left: string, right: string): number => ORDER.compare(left, right);
