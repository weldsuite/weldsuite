/**
 * The ZIP list of a tax zone as the user types it ("78701, 78702, 78710-78799")
 * and as the API stores it (`["78701", "78702", { from: "78710", to: "78799" }]`).
 *
 * Commas, semicolons, spaces and line breaks all separate entries, and a range
 * may be written with a hyphen, an en dash or an em dash, with or without
 * spaces around it. A ZIP+4 is refused rather than guessed at: zones are
 * matched on the five-digit ZIP.
 */
import type { ZipEntry } from '@/lib/api/domains/weldbooks-sales-tax-setup';

/** What the server accepts for one zone. */
export const MAX_ZIP_ENTRIES = 5000;

export type ZipListProblem = 'format' | 'zip4' | 'backwards' | 'too_many';

export interface ZipListError {
  /** The text that could not be read; empty for a problem with the list as a whole. */
  token: string;
  problem: ZipListProblem;
}

export interface ParsedZipList {
  entries: ZipEntry[];
  errors: ZipListError[];
}

const ZIP5 = /^\d{5}$/;
const RANGE = /^(\d{5})-(\d{5})$/;
const ZIP4 = /^\d{5}-\d{4}$/;

function entryKey(entry: ZipEntry): string {
  return typeof entry === 'string' ? entry : `${entry.from}-${entry.to}`;
}

/** Read what the user typed. Duplicates collapse; entries keep the order they were typed in. */
export function parseZipList(text: string): ParsedZipList {
  const tokens = text
    .replace(/\s*[-–—]\s*/g, '-')
    .split(/[\s,;]+/)
    .filter((token) => token.length > 0);

  const entries: ZipEntry[] = [];
  const errors: ZipListError[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    let entry: ZipEntry | null = null;
    if (ZIP5.test(token)) {
      entry = token;
    } else if (ZIP4.test(token)) {
      errors.push({ token, problem: 'zip4' });
      continue;
    } else {
      const range = RANGE.exec(token);
      if (!range) {
        errors.push({ token, problem: 'format' });
        continue;
      }
      const [, from, to] = range;
      if (from > to) {
        errors.push({ token, problem: 'backwards' });
        continue;
      }
      // A range of one ZIP is that ZIP.
      entry = from === to ? from : { from, to };
    }
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }

  if (entries.length > MAX_ZIP_ENTRIES) errors.push({ token: '', problem: 'too_many' });
  return { entries, errors };
}

/** The list as text, one entry per comma: the text `parseZipList` reads back. */
export function formatZipList(entries: readonly ZipEntry[] | null | undefined): string {
  return (entries ?? []).map((entry) => (typeof entry === 'string' ? entry : `${entry.from}-${entry.to}`)).join(', ');
}

/** How many ZIP codes the list covers (a range counts every ZIP in it). */
export function countZips(entries: readonly ZipEntry[] | null | undefined): number {
  let total = 0;
  for (const entry of entries ?? []) {
    total += typeof entry === 'string' ? 1 : Number(entry.to) - Number(entry.from) + 1;
  }
  return total;
}

/** The first few entries as text with "+N more", for a table cell. */
export function summarizeZipList(
  entries: readonly ZipEntry[] | null | undefined,
  limit = 4,
): { text: string; more: number } {
  const list = entries ?? [];
  return { text: formatZipList(list.slice(0, limit)), more: Math.max(list.length - limit, 0) };
}

/** True when the ZIP is covered by an entry of the list (the inclusive range rule the engine uses). */
export function zipListCovers(entries: readonly ZipEntry[] | null | undefined, zip: string): boolean {
  const five = zip.trim().slice(0, 5);
  if (!ZIP5.test(five)) return false;
  return (entries ?? []).some((entry) => (typeof entry === 'string' ? entry === five : five >= entry.from && five <= entry.to));
}
