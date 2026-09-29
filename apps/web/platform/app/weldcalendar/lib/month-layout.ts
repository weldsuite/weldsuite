/**
 * Month-grid layout maths.
 *
 * The month view gives every week row an equal, fixed share of the available
 * height (rows never grow with their content). How many event chips fit in a
 * day cell is therefore a pure function of the row height, which keeps the
 * "+N more" decision testable without a layout engine.
 */

/** Height of one event chip (and of the "+N more" line), in px. */
export const MONTH_CHIP_HEIGHT = 20;
/** Vertical gap between chips in a cell, in px (Tailwind `space-y-0.5`). */
export const MONTH_CHIP_GAP = 2;
/**
 * Height taken by everything in a day cell that is not a chip: the cell's own
 * vertical padding (`p-1` = 8px) plus the day-number row (`h-6` + `mb-0.5` =
 * 26px).
 */
export const MONTH_CELL_CHROME = 34;
/** Capacity used until the grid has been measured (first paint, SSR, tests). */
export const MONTH_DEFAULT_CAPACITY = 3;

/** How many chip-height slots fit in a day cell of the given height. */
export function monthCellCapacity(rowHeight: number): number {
  const available = rowHeight - MONTH_CELL_CHROME;
  if (!Number.isFinite(available) || available <= 0) return 0;
  return Math.max(
    0,
    Math.floor((available + MONTH_CHIP_GAP) / (MONTH_CHIP_HEIGHT + MONTH_CHIP_GAP)),
  );
}

export interface MonthCellSplit {
  /** Number of leading events to render as chips. */
  visible: number;
  /** Number of events collapsed into the "+N more" line (0 = no line). */
  hidden: number;
}

/**
 * Decide how many chips to render for a day with `total` events when the cell
 * has room for `capacity` slots. The "+N more" line occupies a slot itself, so
 * whenever events overflow, one chip is given up to make room for it.
 *
 * `reserved` slots are held back for non-event content (e.g. the quick-create
 * preview chip on the selected day).
 */
export function splitMonthCellEvents(
  total: number,
  capacity: number,
  reserved = 0,
): MonthCellSplit {
  const slots = Math.max(0, capacity - reserved);
  if (total <= slots) return { visible: total, hidden: 0 };
  const visible = Math.max(0, slots - 1);
  return { visible, hidden: total - visible };
}
