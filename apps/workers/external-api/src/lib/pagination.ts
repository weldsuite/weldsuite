/**
 * Cursor pagination helpers.
 *
 * Cursors are opaque base64-encoded strings carrying `{ ts, id }` so we can
 * sort by `updatedAt DESC` and tie-break with `id` for stable ordering.
 */

export interface Cursor {
  /** ISO timestamp of the row at the cursor position. */
  ts: string;
  /** ID of the row at the cursor position. */
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c));
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(atob(raw)) as Cursor;
    if (typeof decoded.ts !== 'string' || typeof decoded.id !== 'string') return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Default page size + maximum allowed via `?limit=`. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function clampLimit(raw: number | string | undefined): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!n || !Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}
