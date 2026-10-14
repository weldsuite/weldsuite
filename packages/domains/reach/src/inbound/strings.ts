/**
 * Linear-time string helpers for parsing untrusted mail.
 *
 * Message bodies are written by strangers, and a Worker has a small CPU
 * budget. Regular expressions that can backtrack (`.*` next to `\s*`, a lazy
 * match inside a repeated group, `x+$`) turn a megabyte of crafted text into
 * seconds of CPU, so the parsers use these scans instead.
 */

/** `value` without any leading or trailing characters from `chars`. */
export function trimEdges(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value.charAt(start))) start++;
  while (end > start && chars.includes(value.charAt(end - 1))) end--;
  return value.slice(start, end);
}

/** `value` without trailing characters from `chars`. */
export function trimEnd(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value.charAt(end - 1))) end--;
  return value.slice(0, end);
}

/** `value` with every `( ... )` comment removed (nesting is not interpreted: the first `)` closes). */
export function stripParenthesized(value: string): string {
  let out = '';
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')' && depth > 0) depth--;
    else if (depth === 0) out += char;
  }
  return out;
}

const LOCAL_CHARS = new Set("abcdefghijklmnopqrstuvwxyz0123456789._%+'-");
const DOMAIN_CHARS = new Set('abcdefghijklmnopqrstuvwxyz0123456789.-');

function isLetter(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

function validDomain(domain: string): boolean {
  const lastDot = domain.lastIndexOf('.');
  if (lastDot <= 0 || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  const tld = domain.slice(lastDot + 1);
  return tld.length >= 2 && [...tld].every(isLetter);
}

export interface FoundEmail {
  /** Lower-cased address. */
  email: string;
  /** Index in the searched text where the address starts. */
  start: number;
  /** Index just past its last character. */
  end: number;
}

/** Every email address in `text`, in order. One pass: each `@` is expanded to its neighbours once. */
export function findEmails(text: string): FoundEmail[] {
  const lower = text.toLowerCase();
  const found: FoundEmail[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf('@', from);
    if (at === -1) break;
    from = at + 1;

    let start = at;
    while (start > 0 && LOCAL_CHARS.has(lower.charAt(start - 1))) start--;
    let end = at + 1;
    while (end < lower.length && DOMAIN_CHARS.has(lower.charAt(end))) end++;

    // A trailing dot belongs to the sentence, not the address.
    const domain = trimEnd(lower.slice(at + 1, end), '.-');
    if (start === at || !validDomain(domain)) continue;
    found.push({ email: `${lower.slice(start, at)}@${domain}`, start, end: at + 1 + domain.length });
    from = Math.max(from, at + 1 + domain.length);
  }
  return found;
}

/** The first address that starts within `within` characters after `index`, or null. */
export function emailAfter(text: string, index: number, within = 300): string | null {
  const slice = text.slice(index, index + within);
  return findEmails(slice)[0]?.email ?? null;
}
