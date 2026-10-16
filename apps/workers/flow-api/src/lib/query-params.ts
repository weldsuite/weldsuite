/**
 * Query-string helpers shared by the WeldFlow list routes.
 */

import { z } from 'zod';

/**
 * A boolean query param. `z.coerce.boolean()` is `Boolean(value)`, so the string
 * "false" came out as true (`?myTasks=false` filtered to my tasks); this one
 * reads the spelling. Anything but true/false/1/0 is a 400.
 */
export const queryBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/**
 * A positive-integer `limit` query param, capped at `max`. A missing or
 * non-numeric value (`?limit=abc`) falls back to `fallback` instead of becoming
 * NaN, which Postgres rejects with a 500.
 */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * `%term%` for an `ILIKE` contains-search with the user's `%`, `_` and `\`
 * escaped, so typing "50%" matches the text "50%" rather than everything.
 */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
