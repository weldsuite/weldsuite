/**
 * ID Generation Utility
 *
 * Generates unique IDs with optional prefixes for database records.
 */

/**
 * Generate a unique ID with an optional prefix
 * @param prefix - Optional prefix for the ID (e.g., 'prod', 'inv', 'wh')
 * @returns A unique string ID
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
