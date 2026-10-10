/**
 * Lookup used to place a task in a pipeline column: a stage id maps to itself,
 * and a bare status maps to the FIRST stage (by position) carrying that
 * systemStatus. First-wins matters: a custom stage that shares a systemStatus
 * with a default one (e.g. "Blocked" counting as in_progress) must not steal
 * the tasks whose stageId is null. This is the same resolution the list view
 * and the stage usage counts use.
 */
export function buildStatusToStageId(
  stages: ReadonlyArray<{ id: string; systemStatus?: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of stages) map.set(s.id, s.id);
  for (const s of stages) {
    if (s.systemStatus && !map.has(s.systemStatus)) map.set(s.systemStatus, s.id);
  }
  return map;
}
