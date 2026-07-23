import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useGridContext } from './context';

export interface CellPos {
  row: number;
  col: number;
}

interface CellRange {
  anchor: CellPos;
  head: CellPos;
}

/**
 * Tiny external store driving cell-range selection.
 *
 * Each cell subscribes via `useSyncExternalStore` to *its own* selected
 * boolean — so when the range changes, only the cells whose membership
 * actually flipped re-render. Without this, dragging a selection across a
 * grid with hundreds of cells re-renders every cell on every mousemove and
 * the UI becomes visibly laggy.
 */
class SelectionStore {
  range: CellRange | null = null;
  isSelecting = false;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  setRange(next: CellRange | null) {
    this.range = next;
    this.emit();
  }

  setSelecting(next: boolean) {
    if (this.isSelecting === next) return;
    this.isSelecting = next;
    // Emit so subscribers (e.g. `useIsSelectingCells`) can react when a
    // drag starts/ends — used to suppress hover-revealed UI during drags.
    this.emit();
  }

  start(pos: CellPos) {
    this.range = { anchor: pos, head: pos };
    this.isSelecting = true;
    this.emit();
  }

  extend(pos: CellPos) {
    const r = this.range;
    if (!r) {
      this.range = { anchor: pos, head: pos };
      this.emit();
      return;
    }
    if (r.head.row === pos.row && r.head.col === pos.col) return;
    this.range = { anchor: r.anchor, head: pos };
    this.emit();
  }

  clear() {
    if (!this.range && !this.isSelecting) return;
    this.range = null;
    this.isSelecting = false;
    this.emit();
  }

  isCellSelected(row: number, col: number): boolean {
    const r = this.range;
    if (!r) return false;
    const minR = Math.min(r.anchor.row, r.head.row);
    const maxR = Math.max(r.anchor.row, r.head.row);
    const minC = Math.min(r.anchor.col, r.head.col);
    const maxC = Math.max(r.anchor.col, r.head.col);
    return row >= minR && row <= maxR && col >= minC && col <= maxC;
  }

  /**
   * Cell state encoded as a bitfield so `useSyncExternalStore` can compare
   * with primitive equality and only re-render cells whose state actually
   * changed (rather than allocating a fresh object on every store emit and
   * re-rendering every cell).
   *
   *   bit 0 (1)  = selected (cell is inside the range)
   *   bit 1 (2)  = anchor (the click-origin cell — gets the white-fill +
   *                full blue border treatment, like Attio)
   *   bit 2 (4)  = top edge of the range
   *   bit 3 (8)  = bottom edge of the range
   *   bit 4 (16) = left edge of the range
   *   bit 5 (32) = right edge of the range
   */
  getCellState(row: number, col: number): number {
    const r = this.range;
    if (!r) return 0;
    const minR = Math.min(r.anchor.row, r.head.row);
    const maxR = Math.max(r.anchor.row, r.head.row);
    const minC = Math.min(r.anchor.col, r.head.col);
    const maxC = Math.max(r.anchor.col, r.head.col);
    if (row < minR || row > maxR || col < minC || col > maxC) return 0;
    let state = 1;
    if (row === r.anchor.row && col === r.anchor.col) state |= 2;
    if (row === minR) state |= 4;
    if (row === maxR) state |= 8;
    if (col === minC) state |= 16;
    if (col === maxC) state |= 32;
    return state;
  }
}

interface CellSelectionContextValue {
  store: SelectionStore;
  startSelection: (pos: CellPos) => void;
  extendSelection: (pos: CellPos) => void;
}

const CellSelectionContext = createContext<CellSelectionContextValue | null>(null);

interface CellSelectionProviderProps<TEntity> {
  entities: TEntity[];
  children: React.ReactNode;
}

/**
 * Spreadsheet-style cell range selection: click+drag to select a rectangle
 * of cells, Cmd/Ctrl+C copies the selected values as TSV (tab-separated, one
 * row per line) so it pastes cleanly into Sheets / Excel.
 */
export function CellSelectionProvider<TEntity>({ entities, children }: CellSelectionProviderProps<TEntity>) {
  const { getVisibleColumns, getEntityWithOptimisticUpdates, state } = useGridContext<TEntity>();
  const { customFieldData } = state;
  // The store outlives renders. Stable identity lets cells subscribe once
  // and skip re-binding during drags.
  const storeRef = useRef<SelectionStore | null>(null);
  if (!storeRef.current) storeRef.current = new SelectionStore();
  const store = storeRef.current;

  const startSelection = useCallback((pos: CellPos) => store.start(pos), [store]);
  const extendSelection = useCallback((pos: CellPos) => {
    if (!store.isSelecting) return;
    store.extend(pos);
  }, [store]);

  // Global mouseup ends the drag — selection rectangle stays put.
  useEffect(() => {
    const handleUp = () => {
      if (store.isSelecting) store.setSelecting(false);
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [store]);

  // Cmd/Ctrl+C — copy the selected rectangle to the clipboard as TSV.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const isCopy = (e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C');
      if (!isCopy) return;
      const r = store.range;
      if (!r) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      const visibleColumns = getVisibleColumns();
      const minR = Math.min(r.anchor.row, r.head.row);
      const maxR = Math.max(r.anchor.row, r.head.row);
      const minC = Math.min(r.anchor.col, r.head.col);
      const maxC = Math.max(r.anchor.col, r.head.col);
      const lines: string[] = [];
      for (let row = minR; row <= maxR; row++) {
        const entity = entities[row];
        if (!entity) continue;
        const merged = getEntityWithOptimisticUpdates(entity);
        const cells: string[] = [];
        for (let col = minC; col <= maxC; col++) {
          const column = visibleColumns[col];
          if (!column) {
            cells.push('');
            continue;
          }
          let value: unknown;
          if (column.isCustom) {
            const id = (merged as any)?.id ?? null;
            value = id ? customFieldData[id]?.[column.id] : undefined;
          } else {
            value = column.getValue(merged);
          }
          cells.push(formatCopyValue(value));
        }
        lines.push(cells.join('\t'));
      }
      const text = lines.join('\n');
      if (!text) return;
      e.preventDefault();
      void navigator.clipboard.writeText(text).catch(() => {});
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [entities, getEntityWithOptimisticUpdates, getVisibleColumns, customFieldData, store]);

  // While a drag is active, stamp `data-grid-dragging` on <body> so global
  // CSS can suppress hover-revealed UI (e.g. the favorite star, ghost
  // buttons that appear on row hover) — those would otherwise pop in and
  // out as the cursor crosses cells, which reads as visual noise.
  useEffect(() => {
    return store.subscribe(() => {
      if (typeof document === 'undefined') return;
      if (store.isSelecting) {
        document.body.dataset.gridDragging = 'true';
      } else {
        delete document.body.dataset.gridDragging;
      }
    });
  }, [store]);

  // Click outside the table clears the selection.
  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-grid-cell="1"]')) return;
      store.clear();
    };
    window.addEventListener('mousedown', handleDown);
    return () => window.removeEventListener('mousedown', handleDown);
  }, [store]);

  const value = useMemo<CellSelectionContextValue>(
    () => ({ store, startSelection, extendSelection }),
    [store, startSelection, extendSelection],
  );

  return <CellSelectionContext.Provider value={value}>{children}</CellSelectionContext.Provider>;
}

/**
 * Returns the bitfield state for the given cell:
 *   0          = not in selection
 *   bit 0 (1)  = inside the range
 *   bit 1 (2)  = anchor cell
 *   bit 2 (4)  = top edge
 *   bit 3 (8)  = bottom edge
 *   bit 4 (16) = left edge
 *   bit 5 (32) = right edge
 *
 * Uses an external store so each cell only re-renders when its own state
 * actually changes — primitive number compare is cheap and exact, so a
 * cell that's still "in the middle of the range" with same edges won't
 * re-render even when the head moves elsewhere.
 */
export function useCellSelectionState(row: number, col: number): number {
  const ctx = useContext(CellSelectionContext);
  const subscribe = ctx ? ctx.store.subscribe : NOOP_SUBSCRIBE;
  const getSnapshot = useCallback(() => {
    if (!ctx) return 0;
    return ctx.store.getCellState(row, col);
  }, [ctx, row, col]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/** Convenience for the few callers that only need the boolean. */
function useIsCellSelected(row: number, col: number): boolean {
  return useCellSelectionState(row, col) !== 0;
}

/**
 * Subscribes to whether a cell drag is currently in progress. Used to
 * suppress hover-revealed UI (favorite stars, Plus icons, etc.) during a
 * drag so they don't pop in/out as the cursor crosses cells.
 */
function useIsSelectingCells(): boolean {
  const ctx = useContext(CellSelectionContext);
  const subscribe = ctx ? ctx.store.subscribe : NOOP_SUBSCRIBE;
  const getSnapshot = useCallback(() => ctx?.store.isSelecting ?? false, [ctx]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Returns the action handlers (start/extend) that GridRow uses on the cell
 * <td>. These are stable references and never trigger a re-render on
 * selection change.
 */
export function useCellSelectionActions() {
  const ctx = useContext(CellSelectionContext);
  if (!ctx) {
    return EMPTY_ACTIONS;
  }
  return { startSelection: ctx.startSelection, extendSelection: ctx.extendSelection };
}

const NOOP_SUBSCRIBE = (_: () => void) => () => {};
const EMPTY_ACTIONS = {
  startSelection: (_: CellPos) => {},
  extendSelection: (_: CellPos) => {},
};

function formatCopyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => formatCopyValue(v)).join(', ');
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as any;
    if (typeof v.label === 'string') return v.label;
    if (typeof v.name === 'string') return v.name;
    if (typeof v.title === 'string') return v.title;
    if (typeof v.email === 'string') return v.email;
    if (typeof v.city === 'string' || typeof v.country === 'string') {
      return [v.city, v.state, v.country].filter(Boolean).join(', ');
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}
