/** The most addresses the server takes in `to`, and in `cc`. */
export const MAX_RECIPIENTS = 10;

/** A deliberately plain check: one `@`, a dot in the domain, no spaces. The mail server has the last word. */
const FORBIDDEN_CHARACTER = /[\s@,;]/;

/**
 * Plain string parsing rather than one regex: `^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$`
 * backtracks quadratically on a long domain without a usable dot.
 */
export function isEmailAddress(value: string): boolean {
  const at = value.indexOf('@');
  if (at < 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (FORBIDDEN_CHARACTER.test(local) || FORBIDDEN_CHARACTER.test(domain)) return false;
  // A dot with at least one character on each side.
  const dot = domain.indexOf('.', 1);
  return dot !== -1 && dot < domain.length - 1;
}

/** The addresses in a text field: separated by commas, semicolons or spaces, without duplicates. */
export function parseAddresses(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const address = part.trim();
    const key = address.toLowerCase();
    if (!address || seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

export type AddressProblem =
  | { kind: 'required' }
  | { kind: 'tooMany'; max: number }
  | { kind: 'invalid'; address: string };

/** What is wrong with the addresses in a field, or null when they are fine. An empty optional field is fine. */
export function addressProblem(text: string, options: { required: boolean }): AddressProblem | null {
  const list = parseAddresses(text);
  if (list.length === 0) return options.required ? { kind: 'required' } : null;
  if (list.length > MAX_RECIPIENTS) return { kind: 'tooMany', max: MAX_RECIPIENTS };
  const invalid = list.find((address) => !isEmailAddress(address));
  return invalid ? { kind: 'invalid', address: invalid } : null;
}
