import { randomBytes } from 'node:crypto';

/**
 * Generate a unique ID with an optional prefix.
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Array.from(randomBytes(8), (b) => (b % 36).toString(36)).join('');
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
