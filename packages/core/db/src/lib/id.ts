/**
 * Row ids: `<prefix>_<base36 time><8 random base36>`, for the `varchar(30)`
 * id columns. `@weldsuite/worker-kit/id` re-exports this.
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
