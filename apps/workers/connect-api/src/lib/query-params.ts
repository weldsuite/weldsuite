/**
 * Query-string parsing helpers for list routes.
 */

/**
 * Parse a `limit` query value into a safe SQL LIMIT: an integer between 1 and
 * `max`. A missing or non-numeric value falls back to `fallback` (clamped to
 * `max`); a zero or negative one is raised to 1. So `?limit=abc` or
 * `?limit=-1` never reaches the database as `LIMIT NaN` / `LIMIT -1`.
 */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return Math.min(fallback, max);
  return Math.min(Math.max(parsed, 1), max);
}
