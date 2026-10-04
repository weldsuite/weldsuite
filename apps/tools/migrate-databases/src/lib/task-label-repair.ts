/**
 * Pure mapping used by `repair-task-label-names.ts`: turns the label NAMES an
 * older WeldFlow mobile build wrote into `tasks.labels` back into label IDs.
 */

export interface LabelRow {
  id: string;
  name: string;
  projectId: string | null;
  deletedAt: Date | string | null;
}

export interface LabelIndex {
  /** Every label ID, soft-deleted ones included. */
  ids: Set<string>;
  /** Live labels by exact name. */
  byName: Map<string, LabelRow[]>;
}

export interface LabelRepair {
  /** The repaired `tasks.labels` value. */
  labels: string[];
  /** name -> label ID for each entry that was mapped. */
  mapped: { name: string; id: string }[];
  /** Names that match more than one label, with no way to pick. Left as they are. */
  ambiguous: string[];
  /** Entries that are neither a label ID nor a live label's name. Left as they are. */
  unresolved: string[];
  changed: boolean;
}

export function buildLabelIndex(rows: readonly LabelRow[]): LabelIndex {
  const ids = new Set<string>();
  const byName = new Map<string, LabelRow[]>();
  for (const row of rows) {
    ids.add(row.id);
    if (row.deletedAt) continue;
    const sameName = byName.get(row.name);
    if (sameName) sameName.push(row);
    else byName.set(row.name, [row]);
  }
  return { ids, byName };
}

/**
 * Picks the label a name refers to on a task in `taskProjectId`: the task's own
 * project's label first, then the workspace-wide one (no project), then the
 * only label with that name anywhere. Returns null when that is not one label.
 */
function pickLabel(candidates: readonly LabelRow[], taskProjectId: string | null): LabelRow | null {
  if (taskProjectId) {
    const inProject = candidates.filter((l) => l.projectId === taskProjectId);
    if (inProject.length === 1) return inProject[0];
    if (inProject.length > 1) return null;
  }
  const workspaceWide = candidates.filter((l) => l.projectId === null);
  if (workspaceWide.length === 1) return workspaceWide[0];
  if (workspaceWide.length > 1) return null;
  return candidates.length === 1 ? candidates[0] : null;
}

export function repairTaskLabels(
  labels: readonly string[],
  taskProjectId: string | null,
  index: LabelIndex,
): LabelRepair {
  const repaired: string[] = [];
  const mapped: LabelRepair['mapped'] = [];
  const ambiguous: string[] = [];
  const unresolved: string[] = [];

  for (const entry of labels) {
    let value = entry;
    if (!index.ids.has(entry)) {
      const candidates = index.byName.get(entry);
      const label = candidates ? pickLabel(candidates, taskProjectId) : null;
      if (label) {
        value = label.id;
        mapped.push({ name: entry, id: label.id });
      } else if (candidates) {
        ambiguous.push(entry);
      } else {
        unresolved.push(entry);
      }
    }
    // A label stored as both its ID and its name collapses to one entry.
    if (!repaired.includes(value)) repaired.push(value);
  }

  const changed = repaired.length !== labels.length || repaired.some((v, i) => v !== labels[i]);
  return { labels: repaired, mapped, ambiguous, unresolved, changed };
}
