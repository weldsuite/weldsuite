/**
 * Local copy of the workers' `generateId`. Kept here so the package has no
 * dependency on any one worker's lib; the format must stay identical because
 * the ids it produces land in tenant `varchar(30)` id columns.
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
