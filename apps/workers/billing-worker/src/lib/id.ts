/**
 * ID generation helper for rows created directly by the billing worker
 * (app-subscription installs, developer payout accounts).
 *
 * Mirrors the local `generateId(prefix)` helper used elsewhere in the repo
 * (e.g. packages/core/db/src/lib/admin.ts, packages/core/worker-kit/src/id.ts) — not a
 * shared package export, just the same simple timestamp+random scheme kept
 * consistent across workers.
 */
function randomBase36(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = randomBase36(8);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
