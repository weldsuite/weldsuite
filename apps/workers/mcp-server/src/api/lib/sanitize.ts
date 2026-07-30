/**
 * Strip server-owned fields from a (possibly `.passthrough()`) request body so
 * an external API caller can't override identity, ownership, timestamps, or the
 * soft-delete flag by smuggling extra keys past Zod validation.
 *
 * Used on both create and update handlers — the route assigns these fields
 * itself from the authenticated session / server clock.
 */
const SERVER_OWNED_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'connectedByUserId',
  'createdByUserId',
] as const;

export function stripServerFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const key of SERVER_OWNED_FIELDS) delete out[key];
  return out;
}
