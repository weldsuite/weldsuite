/**
 * Ids for statement lines whose file carries none (CSV, BAI2, banks without
 * FITIDs): a hash of the line's date, amount and text plus a counter for
 * identical lines in the same file, so importing the same file twice finds
 * every line again.
 */

/** Two FNV-1a passes with different offsets, 16 hex characters. Not cryptographic. */
export function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0xdeadbeef;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** `prefix:<hash of parts>` plus `#n` from the second identical line on. */
export function syntheticExternalId(
  prefix: string,
  parts: Array<string | number | null | undefined>,
  occurrence: number,
): string {
  const base = `${prefix}:${shortHash(parts.map((p) => String(p ?? '').trim().toLowerCase()).join('|'))}`;
  return occurrence > 1 ? `${base}#${occurrence}` : base;
}

/** Counts how often a key was seen: 1 for the first time, 2 for the second, ... */
export function occurrenceCounter(): (key: string) => number {
  const seen = new Map<string, number>();
  return (key) => {
    const next = (seen.get(key) ?? 0) + 1;
    seen.set(key, next);
    return next;
  };
}

/** Collapse whitespace and trim, for descriptions and names read from files. */
export function cleanText(value: string | null | undefined): string {
  return (value ?? '').replaceAll(/\s+/g, ' ').trim();
}
