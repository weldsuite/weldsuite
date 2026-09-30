/**
 * ID Generation Utility
 *
 * Generates unique IDs with optional prefixes for database records.
 *
 * Package-internal copy of `apps/api-worker/src/lib/id.ts` (identical
 * implementation), so this package carries no import back into a worker.
 * Not re-exported from the barrel — consumers already have their own
 * `generateId` (e.g. `apps/workers/workspace-worker/src/lib/id.ts`).
 */

function randomBase36(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/**
 * Generate a unique ID with an optional prefix
 * @param prefix - Optional prefix for the ID (e.g., 'prod', 'inv', 'wh')
 * @returns A unique string ID
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = randomBase36(8);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
