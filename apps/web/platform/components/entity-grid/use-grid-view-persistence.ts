import { useEffect, useRef } from 'react';
import type { GridColumnDef } from './types';

export interface GridViewPayload {
  columnVisibility: Record<string, boolean>;
  columnWidths: Record<string, number>;
}

/** Debounce between the last column/width change and the PUT. */
export const GRID_VIEW_SAVE_DEBOUNCE_MS = 500;

interface ColumnLike {
  id: string;
  visible?: boolean;
  width?: number;
}

/**
 * Builds the PUT body for the current grid state, or `null` when nothing the
 * user could have changed differs from the last-saved view.
 *
 * The comparison baseline for a column is its last-saved value, falling back
 * to the config default for columns the saved view has never mentioned (new
 * custom fields, new built-ins). That way columns that merely *appear* after
 * mount (custom field defs / customer statuses arriving, config re-memoised
 * after an unrelated company PATCH) never count as a change.
 *
 * The body is merged on top of the saved view so keys for columns that are not
 * rendered right now (custom:* columns whose definitions have not loaded yet,
 * columns behind a feature flag) are preserved instead of being dropped by the
 * PUT, which replaces the whole row.
 */
export function buildGridViewPayload(args: {
  columns: ColumnLike[];
  columnWidths: Record<string, number>;
  configColumns: ColumnLike[];
  saved: GridViewPayload;
}): GridViewPayload | null {
  const { columns, columnWidths, configColumns, saved } = args;
  const configById = new Map(configColumns.map((c) => [c.id, c]));

  let changed = false;
  const visibility: Record<string, boolean> = {};
  for (const col of columns) {
    const current = col.visible !== false;
    visibility[col.id] = current;
    const known = saved.columnVisibility[col.id];
    const baseline = known ?? (configById.has(col.id) ? configById.get(col.id)!.visible !== false : undefined);
    if (baseline !== current) changed = true;
  }

  const widths: Record<string, number> = {};
  for (const [id, width] of Object.entries(columnWidths)) {
    widths[id] = width;
    const baseline = saved.columnWidths[id] ?? configById.get(id)?.width;
    if (baseline !== width) changed = true;
  }

  if (!changed) return null;
  return {
    columnVisibility: { ...saved.columnVisibility, ...visibility },
    columnWidths: { ...saved.columnWidths, ...widths },
  };
}

/**
 * Persists column visibility + widths, but only when the user actually changed
 * them relative to the last-saved view. Never writes during hydration: the
 * baseline is the view the server returned (`initialVisibility` /
 * `initialColumnWidths`), and a PUT only happens when the live state differs.
 */
export function useGridViewPersistence<TEntity>(args: {
  columns: GridColumnDef<TEntity>[];
  columnWidths: Record<string, number>;
  configColumns: GridColumnDef<TEntity>[];
  initialVisibility?: Record<string, boolean> | null;
  initialColumnWidths?: Record<string, number> | null;
  save: (payload: GridViewPayload) => Promise<unknown>;
}): void {
  const { columns, columnWidths, configColumns, initialVisibility, initialColumnWidths, save } = args;

  // Last view known to be on the server. Seeded from the fetched view; replaced
  // after each successful PUT.
  const savedRef = useRef<GridViewPayload>({
    columnVisibility: { ...(initialVisibility ?? {}) },
    columnWidths: { ...(initialColumnWidths ?? {}) },
  });
  const configColumnsRef = useRef(configColumns);
  configColumnsRef.current = configColumns;
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const timer = setTimeout(() => {
      const payload = buildGridViewPayload({
        columns,
        columnWidths,
        configColumns: configColumnsRef.current,
        saved: savedRef.current,
      });
      if (!payload) return;
      saveRef
        .current(payload)
        .then(() => {
          savedRef.current = payload;
        })
        .catch(() => {
          // silent — best-effort persistence; the next change retries
        });
    }, GRID_VIEW_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [columns, columnWidths]);
}
