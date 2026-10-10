/**
 * Re-applying a saved grid view (column visibility + widths) to live grid
 * state when the view arrives, or changes, after the grid has mounted.
 *
 * The saved view comes from a query, and a grid can mount before that query
 * has data: while the persisted query cache is still restoring after a reload,
 * the query is "pending" but not "loading", so the grid renders with the
 * config defaults first. Reading the view only in the initial `useState` then
 * left the table on the defaults for good. The helpers below layer the view on
 * top of whatever the grid is showing, without touching columns the user has
 * changed since.
 */

interface ColumnLike {
  id: string;
  visible?: boolean;
}

export type SavedVisibility = Record<string, boolean> | null | undefined;
export type SavedWidths = Record<string, number> | null | undefined;

/** Shallow content equality for saved-view records (identity changes on every refetch). */
export function sameRecord<V>(
  a: Record<string, V> | null | undefined,
  b: Record<string, V> | null | undefined,
): boolean {
  if (a === b) return true;
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && left[key] === right[key]);
}

/**
 * Applies `next` to every column the user has not changed since `previous`.
 *
 * A column counts as "untouched" when it still shows what `previous` (the view
 * the grid was last in step with) would have given it, falling back to the
 * config default for columns `previous` never mentioned. Those follow `next`;
 * any other column carries a user override and is left alone. Returns the same
 * array when nothing changes so callers can skip a render.
 */
export function reconcileSavedVisibility<T extends ColumnLike>(
  columns: T[],
  args: { previous: SavedVisibility; next: SavedVisibility; configColumns: ColumnLike[] },
): T[] {
  const { previous, next, configColumns } = args;
  if (!next) return columns;
  const configById = new Map(configColumns.map((c) => [c.id, c]));

  let changed = false;
  const result = columns.map((col) => {
    const target = next[col.id];
    if (target === undefined) return col;
    const current = col.visible !== false;
    if (current === target) return col;
    const baseline = previous?.[col.id] ?? (configById.get(col.id)?.visible !== false);
    if (current !== baseline) return col;
    changed = true;
    return { ...col, visible: target };
  });
  return changed ? result : columns;
}

/** Same as {@link reconcileSavedVisibility}, for column widths. */
export function reconcileSavedWidths(
  widths: Record<string, number>,
  args: { previous: SavedWidths; next: SavedWidths; configWidths: Record<string, number> },
): Record<string, number> {
  const { previous, next, configWidths } = args;
  if (!next) return widths;

  let changed = false;
  const result = { ...widths };
  for (const [id, target] of Object.entries(next)) {
    const current = widths[id];
    // Columns the grid does not have yet (custom fields still loading) get
    // their saved width when they are merged in, so they are not tracked here.
    if (current === undefined || current === target) continue;
    const baseline = previous?.[id] ?? configWidths[id];
    if (current !== baseline) continue;
    result[id] = target;
    changed = true;
  }
  return changed ? result : widths;
}
