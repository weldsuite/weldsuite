/**
 * ID generation helper for rows created directly by the billing worker
 * (app-subscription installs, developer payout accounts).
 *
 * Mirrors the local `generateId(prefix)` helper used elsewhere in the repo
 * (e.g. packages/core/db/src/lib/admin.ts, apps/workers/app-api/src/lib/id.ts) — not a
 * shared package export, just the same simple timestamp+random scheme kept
 * consistent across workers.
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
