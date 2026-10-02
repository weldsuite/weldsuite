function randomBase36(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/**
 * Local copy of the workers' `generateId`. Kept here so the package has no
 * dependency on any one worker's lib; the format must stay identical because
 * the ids it produces land in tenant `varchar(30)` id columns.
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = randomBase36(8);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
