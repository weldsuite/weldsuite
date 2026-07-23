const DEFAULT_IGNORE_FIELDS = ['updatedAt'];

/**
 * Compare an existing record against the incoming update payload.
 *
 * Returns a changes map, or `null` when nothing actually changed — callers
 * should skip publishing when the return value is null.
 */
export function computeChanges(
  oldRecord: Record<string, unknown>,
  newData: Record<string, unknown>,
  ignoreFields: string[] = DEFAULT_IGNORE_FIELDS,
): Record<string, { old: unknown; new: unknown }> | null {
  const changes: Record<string, { old: unknown; new: unknown }> = {};

  for (const key of Object.keys(newData)) {
    if (ignoreFields.includes(key)) continue;
    if (newData[key] === undefined) continue;

    const oldVal = oldRecord[key];
    const newVal = newData[key];

    // Deep comparison via JSON.stringify handles arrays (tags) and objects
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes[key] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}
