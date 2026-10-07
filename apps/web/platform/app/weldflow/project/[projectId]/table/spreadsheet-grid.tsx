import React, { useState, useRef, useCallback, useMemo, useEffect, memo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Filter, ChevronDown } from 'lucide-react';
import type { SpreadsheetRow, SpreadsheetColumn, FilterDescriptor, MergeRange } from './use-spreadsheet';
import { colLabel, normRange } from './types';
import type { CellCoord, NormalizedRange, CellFormat, RichTextRun, CellDataValue } from './types';
import { evaluate, isFormula, adjustFormula } from './formula-engine';
import { getCellFormat, getCellStyle, getDefaultAlign, formatCellDisplay, formatKey, getCellNote, getCellLink } from './cell-format';
import {
  getRichText,
  richTextKey,
  runsToHtml,
  htmlToRuns,
  runsFromPlainText,
  plainTextFromRuns,
  isPlainRuns,
  saveSelection,
} from './rich-text';

// --- Constants ---
const DEFAULT_COL_WIDTH = 100;
const ROW_HEIGHT = 23;
const ROW_NUM_WIDTH = 51;
const MIN_COLS = 26;
const MIN_ROWS = 100;
const BUFFER_ROWS = 4;
const BUFFER_COLS = 2;
const MIN_COL_WIDTH = 40;

/**
 * Pair each rich-text run with a stable key derived from its character offset
 * in the cell text (runs have no id of their own). Empty runs share an offset
 * with their neighbour, so a per-offset counter keeps the keys unique.
 */
function keyRuns(runs: RichTextRun[]): Array<{ run: RichTextRun; key: string }> {
  const seen = new Map<number, number>();
  let offset = 0;
  return runs.map((run) => {
    const dupes = seen.get(offset) ?? 0;
    seen.set(offset, dupes + 1);
    const key = dupes === 0 ? `off-${offset}` : `off-${offset}-${dupes}`;
    offset += run.text.length;
    return { run, key };
  });
}

// --- Cell component (memoized) ---
const Cell = memo(function Cell({
  displayValue,
  isEditing,
  editValue,
  onEditChange,
  inputRef,
  cellStyle,
  align,
  isError,
  cellHeight,
  richTextRuns,
  onRichTextChange,
  onSelectionInfo,
  link,
  note,
}: {
  displayValue: string;
  isEditing: boolean;
  editValue: string;
  onEditChange: (v: string) => void;
  inputRef: React.RefObject<HTMLDivElement | null>;
  cellStyle: React.CSSProperties & { '--cell-rotation'?: string };
  align: 'left' | 'right' | 'center';
  isError: boolean;
  cellHeight: number;
  richTextRuns?: RichTextRun[];
  onRichTextChange?: (runs: RichTextRun[]) => void;
  onSelectionInfo?: (info: { start: number; end: number }) => void;
  link?: string;
  note?: string;
}) {
  const h = cellHeight || ROW_HEIGHT;
  const initializedRef = useRef(false);

  // Set initial content when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current && !initializedRef.current) {
      const runs = richTextRuns && richTextRuns.length > 0 ? richTextRuns : runsFromPlainText(editValue);
      inputRef.current.innerHTML = runsToHtml(runs);
      initializedRef.current = true;
      // Place cursor at end
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          const sel = window.getSelection();
          if (sel) {
            sel.selectAllChildren(inputRef.current);
            sel.collapseToEnd();
          }
        }
      });
    }
    if (!isEditing) {
      initializedRef.current = false;
    }
    // `initializedRef` gates the body so this only actually runs once per edit
    // session; `editValue`/`richTextRuns` are read once on that first run, and
    // `inputRef` is a stable ref object.
  }, [isEditing, editValue, inputRef, richTextRuns]);

  // Track selection changes for toolbar state
  useEffect(() => {
    if (!isEditing || !onSelectionInfo) return;
    const handler = () => {
      if (inputRef.current) {
        const info = saveSelection(inputRef.current);
        if (info) onSelectionInfo(info);
      }
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [isEditing, onSelectionInfo, inputRef]);

  const handleInput = useCallback(() => {
    if (!inputRef.current) return;
    const html = inputRef.current.innerHTML;
    const runs = htmlToRuns(html);
    const plain = plainTextFromRuns(runs);
    onEditChange(plain);
    onRichTextChange?.(runs);
  }, [onEditChange, onRichTextChange, inputRef]);

  if (isEditing) {
    return (
      <div
        ref={inputRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        className="w-full bg-white dark:bg-background outline-none text-foreground"
        style={{
          height: h,
          lineHeight: `${h}px`,
          padding: '0 4px',
          fontSize: 12,
          margin: 0,
          boxSizing: 'border-box',
          display: 'block',
          whiteSpace: 'pre',
          overflow: 'hidden',
          cursor: 'text',
        }}
      />
    );
  }

  const rotation = cellStyle['--cell-rotation'];
  const cleanStyle: React.CSSProperties & { '--cell-rotation'?: string } = { ...cellStyle };
  delete cleanStyle['--cell-rotation'];

  const renderContent = () => {
    let inner: React.ReactNode;
    if (richTextRuns && richTextRuns.length > 0 && !isPlainRuns(richTextRuns)) {
      inner = keyRuns(richTextRuns).map(({ run, key }) => (
        <span
          key={key}
          style={{
            fontWeight: run.bold ? 'bold' : undefined,
            fontStyle: run.italic ? 'italic' : undefined,
            textDecoration: run.strikethrough ? 'line-through' : undefined,
            color: run.textColor,
            fontFamily: run.fontFamily,
            fontSize: run.fontSize ? `${run.fontSize}px` : undefined,
          }}
        >
          {run.text}
        </span>
      ));
    } else {
      inner = displayValue;
    }
    if (link) {
      return (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 underline hover:text-blue-700"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {inner}
        </a>
      );
    }
    return inner;
  };

  return (
    <div
      className={`relative w-full ${isError ? 'text-red-500' : 'text-foreground'}`}
      title={note || undefined}
      style={{
        height: h,
        lineHeight: rotation ? '1.2' : `${h}px`,
        padding: '0 4px',
        fontSize: 12,
        margin: 0,
        boxSizing: 'border-box',
        textAlign: align,
        overflow: rotation ? 'visible' : 'hidden',
        ...cleanStyle,
      }}
    >
      {rotation ? (
        <span
          style={{
            display: 'inline-block',
            transform: `rotate(${rotation})`,
            transformOrigin: 'left bottom',
            whiteSpace: 'nowrap',
          }}
        >
          {renderContent()}
        </span>
      ) : (
        renderContent()
      )}
      {note && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 top-0"
          style={{
            width: 0,
            height: 0,
            borderTop: '6px solid #f59e0b',
            borderLeft: '6px solid transparent',
          }}
        />
      )}
    </div>
  );
});

// --- Internal clipboard ---
// `value` is the raw cell content (formulas preserved); `display` is the evaluated
// text used by "Paste special → Values only"; `format` powers "Format only".
let internalClipboard: {
  text: string;
  width: number;
  height: number;
  cells: Array<{ relCol: number; relRow: number; value: string; display: string; format?: CellFormat }>;
} | null = null;

// Imperative clipboard API exposed to the context menu via the `clipboardApiRef` prop.
export interface SpreadsheetClipboardApi {
  copy: () => void;
  cut: () => void;
  paste: () => void;
  pasteValuesOnly: () => void;
  pasteFormatOnly: () => void;
  pasteFormulaOnly: () => void;
  pasteTransposed: () => void;
}

// --- Dropdown (data-validation list) columns ---
// A column becomes a dropdown when its fieldType is 'select' and it carries a
// non-empty options list. Options are plain strings; each gets a stable colour
// from a small palette so the chips read like status pills.
const DROPDOWN_PALETTE = [
  '#dbeafe', '#dcfce7', '#fef9c3', '#fee2e2', '#f3e8ff',
  '#ffedd5', '#cffafe', '#fce7f3', '#e5e7eb', '#d1fae5',
];

export function getDropdownOptions(col: SpreadsheetColumn | undefined): string[] | null {
  if (col?.fieldType !== 'select') return null;
  const opts = col.options;
  if (Array.isArray(opts) && opts.length > 0) return opts.map((o) => String(o));
  return null;
}

function optionColor(options: string[], value: string): string | undefined {
  const idx = options.indexOf(value);
  return idx >= 0 ? DROPDOWN_PALETTE[idx % DROPDOWN_PALETTE.length] : undefined;
}

// Renders a dropdown cell: the current value as a coloured chip plus a chevron
// that opens the option picker. Selection still works via the parent cell.
const DropdownChip = memo(function DropdownChip({
  value,
  options,
  height,
  onOpen,
}: {
  value: string;
  options: string[];
  height: number;
  onOpen: (rect: DOMRect) => void;
}) {
  const color = value ? optionColor(options, value) : undefined;
  return (
    <div
      className="flex w-full items-center justify-between gap-1 overflow-hidden"
      style={{ height: height || ROW_HEIGHT, padding: '0 4px', boxSizing: 'border-box' }}
    >
      {value ? (
        <span
          className="truncate rounded-full px-2 py-0.5 text-[11px] leading-none text-gray-800 dark:text-gray-900"
          style={{ backgroundColor: color || '#e5e7eb' }}
        >
          {value}
        </span>
      ) : (
        <span className="text-muted-foreground/40 text-[11px]">&nbsp;</span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen((e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      >
        <ChevronDown className="h-3 w-3" />
      </Button>
    </div>
  );
});

// --- Props ---
interface SpreadsheetGridProps {
  columns: SpreadsheetColumn[];
  rows: SpreadsheetRow[];
  onUpdateRow: (rowId: string, data: Record<string, CellDataValue>) => Promise<void>;
  onDeleteRow: (rowId: string) => Promise<void>;
  onBulkDeleteRows: (ids: string[]) => Promise<void>;
  onCreateRow: (initialData?: { data?: Record<string, CellDataValue>; position?: number }) => void;
  onCreateColumn: (data: { name: string; fieldType: string; options?: string[] }) => void;
  onUpdateColumn?: (colId: string, data: { name?: string; width?: number }) => void;
  onFormatCells?: (cells: Array<{ rowId: string; colId: string }>, format: Partial<CellFormat>) => void;
  selectedCell: CellCoord | null;
  onSelectedCellChange: (cell: CellCoord | null) => void;
  editValue: string;
  onEditValueChange: (value: string) => void;
  isEditing: boolean;
  onIsEditingChange: (editing: boolean) => void;
  selectionEnd: CellCoord | null;
  onSelectionEndChange: (end: CellCoord | null) => void;
  onContextMenu?: (e: React.MouseEvent, type: 'cell' | 'column-header' | 'row-number', coord: CellCoord) => void;
  onInlineSelectionChange?: (info: { start: number; end: number } | null) => void;
  editingRuns?: React.RefObject<RichTextRun[]>;
  clipboardApiRef?: React.RefObject<SpreadsheetClipboardApi | null>;
  /** Visual row positions hidden by an active column filter — rendered at height 0. */
  hiddenRows?: Set<number>;
  /** Active column filter, so headers can show funnel buttons. */
  filter?: FilterDescriptor | null;
  /** Invoked when a header filter funnel is clicked; `rect` anchors the popover. */
  onFilterClick?: (colIndex: number, rect: DOMRect) => void;
  /** Merged cell ranges — the anchor (top-left) cell spans them; others hide. */
  merges?: MergeRange[];
}

// --- Pure helpers (kept outside the component to keep it small) ---
type CellRow = SpreadsheetRow | undefined;
type CellCol = SpreadsheetColumn | undefined;

function sameCoord(a: CellCoord, b: CellCoord | null | undefined): boolean {
  return a.col === b?.col && a.row === b?.row;
}

function isInsideRange(range: NormalizedRange, col: number, row: number): boolean {
  return col >= range.minCol && col <= range.maxCol && row >= range.minRow && row <= range.maxRow;
}

/** Fill-drag handle: constrain the cursor to extend the selection along one axis only. */
function constrainFillCoord(coords: CellCoord, sel: NormalizedRange): CellCoord {
  const dCol = Math.abs(coords.col - (coords.col > sel.maxCol ? sel.maxCol : sel.minCol));
  const dRow = Math.abs(coords.row - (coords.row > sel.maxRow ? sel.maxRow : sel.minRow));
  if (dCol >= dRow) {
    return { col: coords.col, row: coords.row < sel.minRow ? sel.minRow : Math.min(coords.row, sel.maxRow) };
  }
  return { col: coords.col < sel.minCol ? sel.minCol : Math.min(coords.col, sel.maxCol), row: coords.row };
}

/** Detects a constant, non-zero numeric step across the seed values ("1, 2, 3" -> 1). */
function detectFillSequence(seedValues: string[]): { last: number; diff: number } | null {
  if (seedValues.length < 2) return null;
  const nums = seedValues.map(Number);
  if (!nums.every((n) => !Number.isNaN(n))) return null;
  const diff = nums[1] - nums[0];
  if (diff === 0) return null;
  if (!nums.every((n, i) => i === 0 || n - nums[i - 1] === diff)) return null;
  return { last: nums.at(-1)!, diff };
}

function collectFillSeedValues(
  sel: NormalizedRange,
  isVertical: boolean,
  getRaw: (col: number, row: number) => string,
): string[] {
  const seeds: string[] = [];
  if (isVertical) {
    for (let r = sel.minRow; r <= sel.maxRow; r++) seeds.push(getRaw(sel.minCol, r));
  } else {
    for (let c = sel.minCol; c <= sel.maxCol; c++) seeds.push(getRaw(c, sel.minRow));
  }
  return seeds;
}

/** Cyclic repeat of the source block; formulas get their references shifted. */
function cyclicFillValue(
  sel: NormalizedRange,
  c: number,
  r: number,
  getRaw: (col: number, row: number) => string,
): string {
  const selWidth = sel.maxCol - sel.minCol + 1;
  const selHeight = sel.maxRow - sel.minRow + 1;
  const srcCol = sel.minCol + ((c - sel.minCol + selWidth) % selWidth);
  const srcRow = sel.minRow + ((r - sel.minRow + selHeight) % selHeight);
  const clampedSrcCol = Math.max(sel.minCol, Math.min(sel.maxCol, srcCol));
  const clampedSrcRow = Math.max(sel.minRow, Math.min(sel.maxRow, srcRow));
  const srcValue = getRaw(clampedSrcCol, clampedSrcRow);
  return isFormula(srcValue) ? adjustFormula(srcValue, r - clampedSrcRow, c - clampedSrcCol) : srcValue;
}

/** Value for a cell outside the source block: number-sequence step, else formula-aware cyclic repeat. */
function fillCellValue(
  sel: NormalizedRange,
  sequence: { last: number; diff: number } | null,
  isVertical: boolean,
  c: number,
  r: number,
  getRaw: (col: number, row: number) => string,
): string {
  if (!sequence) return cyclicFillValue(sel, c, r, getRaw);
  const stepsFromEnd = isVertical ? r - sel.maxRow : c - sel.maxCol;
  return String(sequence.last + sequence.diff * stepsFromEnd);
}

/** Appends blank text columns until column index `col` exists. */
function createColumnsUpTo(
  existingCount: number,
  col: number,
  onCreateColumn: (data: { name: string; fieldType: string }) => void,
): void {
  for (let i = existingCount; i <= col; i++) {
    onCreateColumn({ name: colLabel(i), fieldType: 'text' });
  }
}

// Text of a plain cell value. Column keys only ever hold CellValue; the
// object payloads (formats, rich-text runs) live under prefixed keys.
function plainCellText(value: CellDataValue | undefined): string {
  if (value == null || typeof value === 'object') return '';
  return String(value);
}

function buildNewRowData(colId: string, value: string, runs: RichTextRun[] | null): Record<string, CellDataValue> {
  const data: Record<string, CellDataValue> = { [colId]: value };
  if (runs) data[richTextKey(colId)] = runs;
  return data;
}

function collectSelectionCells(
  sel: NormalizedRange,
  rowByPosition: Map<number, SpreadsheetRow>,
  sortedCols: SpreadsheetColumn[],
): Array<{ rowId: string; colId: string }> {
  const cells: Array<{ rowId: string; colId: string }> = [];
  for (let r = sel.minRow; r <= sel.maxRow; r++) {
    for (let c = sel.minCol; c <= sel.maxCol; c++) {
      const br = rowByPosition.get(r);
      const bc = sortedCols[c];
      if (br && bc) cells.push({ rowId: br.id, colId: bc.id });
    }
  }
  return cells;
}

/** Cell one step away in the direction of an arrow key, clamped to the grid; null for other keys. */
function arrowStep(key: string, from: CellCoord, maxCol: number, maxRow: number): CellCoord | null {
  switch (key) {
    case 'ArrowUp':
      return { col: from.col, row: Math.max(0, from.row - 1) };
    case 'ArrowDown':
      return { col: from.col, row: Math.min(maxRow, from.row + 1) };
    case 'ArrowLeft':
      return { col: Math.max(0, from.col - 1), row: from.row };
    case 'ArrowRight':
      return { col: Math.min(maxCol, from.col + 1), row: from.row };
    default:
      return null;
  }
}

function isErrorDisplayValue(value: string): boolean {
  return value.startsWith('#') && (value.endsWith('!') || value === '#N/A' || value === '#NAME?');
}

/** Per-cell metadata stored next to the value in the row data. */
function getCellExtras(br: CellRow, bc: CellCol) {
  if (!br || !bc) {
    return { fmt: undefined, rt: undefined, note: undefined, link: undefined };
  }
  return {
    fmt: getCellFormat(br.data, bc.id),
    rt: getRichText(br.data, bc.id),
    note: getCellNote(br.data, bc.id),
    link: getCellLink(br.data, bc.id),
  };
}

// A merge hides every covered cell except its top-left anchor.
function isCoveredByMerge(merge: MergeRange | undefined, col: number, row: number): boolean {
  return !!merge && !(merge.minCol === col && merge.minRow === row);
}

export function SpreadsheetGrid({
  columns,
  rows,
  onUpdateRow,
  // `onDeleteRow` / `onBulkDeleteRows` are part of the public prop contract but row
  // deletion is currently dispatched via `onContextMenu` to the parent instead.
  onCreateRow,
  onCreateColumn,
  onUpdateColumn,
  onFormatCells,
  selectedCell,
  onSelectedCellChange,
  editValue,
  onEditValueChange,
  isEditing,
  onIsEditingChange,
  selectionEnd,
  onSelectionEndChange,
  onContextMenu,
  onInlineSelectionChange,
  editingRuns: editingRunsExternal,
  clipboardApiRef,
  hiddenRows,
  filter,
  onFilterClick,
  merges,
}: Readonly<SpreadsheetGridProps>) {
  // Quick lookup: does (col,row) fall inside a merge, and is it the anchor?
  const findMerge = useCallback(
    (col: number, row: number): MergeRange | undefined =>
      merges?.find((m) => col >= m.minCol && col <= m.maxCol && row >= m.minRow && row <= m.maxRow),
    [merges],
  );
  const sortedCols = useMemo(() => [...columns].sort((a, b) => a.position - b.position), [columns]);

  // Position-based lookup: visual row index -> row data (by position field, not array index)
  const rowByPosition = useMemo(() => {
    const map = new Map<number, SpreadsheetRow>();
    for (const r of rows) {
      map.set(r.position, r);
    }
    return map;
  }, [rows]);

  const maxRowPosition = useMemo(() => {
    let max = -1;
    for (const r of rows) {
      if (r.position > max) max = r.position;
    }
    return max;
  }, [rows]);

  const totalCols = Math.max(MIN_COLS, sortedCols.length + 8);
  const totalRows = Math.max(MIN_ROWS, maxRowPosition + 50);

  // --- Local state ---
  const [fillDragEnd, setFillDragEnd] = useState<CellCoord | null>(null);
  // Open dropdown (data-validation list) picker, anchored at the chevron.
  const [openDropdown, setOpenDropdown] = useState<{ col: number; row: number; x: number; y: number; options: string[] } | null>(null);
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const [rowHeights, setRowHeights] = useState<Record<number, number>>({});
  const [editingHeader, setEditingHeader] = useState<number | null>(null);
  const [headerEditValue, setHeaderEditValue] = useState('');

  // Pending cell write: value to commit once a missing column/row is created
  const [pendingWrite, setPendingWrite] = useState<{ col: number; row: number; value: string } | null>(null);

  // Optimistic cell values: tracks committed-but-not-yet-flushed values so cells
  // don't flicker between the edit→display transition while onMutate is still pending.
  const optimisticCellsRef = useRef<Map<string, string>>(new Map());

  // Scroll state for virtualization
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const isFillDraggingRef = useRef(false);
  const inputRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const internalRunsRef = useRef<RichTextRun[]>([]);
  const editingRunsRef = editingRunsExternal || internalRunsRef;
  const [, setInlineSelection] = useState<{ start: number; end: number } | null>(null);
  const isDraggingRef = useRef(false);
  const resizeStartRef = useRef<{ col: number; startX: number; startWidth: number } | null>(null);
  const rowResizeStartRef = useRef<{ row: number; startY: number; startHeight: number } | null>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);

  // Refs for stale closures
  const editValueRef = useRef(editValue);
  editValueRef.current = editValue;
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;
  const selectedCellRef = useRef(selectedCell);
  selectedCellRef.current = selectedCell;
  const selectionEndRef = useRef(selectionEnd);
  selectionEndRef.current = selectionEnd;
  const fillDragEndRef = useRef(fillDragEnd);
  fillDragEndRef.current = fillDragEnd;

  // Clear optimistic values once the real rows data has caught up
  useEffect(() => {
    const pending = optimisticCellsRef.current;
    if (pending.size === 0) return;
    for (const [key, expectedValue] of pending) {
      const [colStr, rowStr] = key.split(',');
      const col = Number(colStr);
      const row = Number(rowStr);
      const bc = sortedCols[col];
      const br = rowByPosition.get(row);
      if (bc && br) {
        const actual = plainCellText(br.data?.[bc.id]);
        if (actual === expectedValue || (expectedValue === '' && (actual === '' || br.data?.[bc.id] === null))) {
          pending.delete(key);
        }
      }
    }
  }, [rows, sortedCols, rowByPosition]);

  // --- Column widths ---
  const getColWidth = useCallback((ci: number): number => {
    if (colWidths[ci] !== undefined) return colWidths[ci];
    const col = sortedCols[ci];
    if (col?.width) return col.width;
    return DEFAULT_COL_WIDTH;
  }, [sortedCols, colWidths]);

  // --- Row heights ---
  const getRowHeight = useCallback((ri: number): number => {
    if (hiddenRows?.has(ri)) return 0; // collapsed by an active filter
    return rowHeights[ri] ?? ROW_HEIGHT;
  }, [rowHeights, hiddenRows]);

  // Cumulative offsets for absolute positioning
  const colOffsets = useMemo(() => {
    const offsets: number[] = [0];
    for (let i = 0; i < totalCols; i++) {
      offsets.push(offsets[i] + getColWidth(i));
    }
    return offsets;
  }, [totalCols, getColWidth]);

  // Cumulative row offsets
  const rowOffsets = useMemo(() => {
    const offsets: number[] = [0];
    for (let i = 0; i < totalRows; i++) {
      offsets.push(offsets[i] + getRowHeight(i));
    }
    return offsets;
  }, [totalRows, getRowHeight]);

  const totalWidth = ROW_NUM_WIDTH + colOffsets[totalCols];
  const totalHeight = rowOffsets[totalRows];

  // --- Virtualization ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    ro.observe(el);
    setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback((e: React.UIEvent) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    setScrollLeft(el.scrollLeft);
  }, []);

  // Binary search for visible row range using variable row heights
  const visibleRowStart = useMemo(() => {
    let lo = 0, hi = totalRows;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowOffsets[mid + 1] <= scrollTop) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - BUFFER_ROWS);
  }, [scrollTop, rowOffsets, totalRows]);

  const visibleRowEnd = useMemo(() => {
    const target = scrollTop + containerSize.height;
    let lo = visibleRowStart, hi = totalRows;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowOffsets[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(totalRows, lo + BUFFER_ROWS);
  }, [scrollTop, containerSize.height, rowOffsets, visibleRowStart, totalRows]);

  // Find visible columns via binary search on offsets
  const visibleColStart = useMemo(() => {
    const target = Math.max(0, scrollLeft - ROW_NUM_WIDTH);
    let lo = 0, hi = totalCols;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colOffsets[mid + 1] <= target) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - BUFFER_COLS);
  }, [scrollLeft, colOffsets, totalCols]);

  const visibleColEnd = useMemo(() => {
    const target = scrollLeft - ROW_NUM_WIDTH + containerSize.width;
    let lo = visibleColStart, hi = totalCols;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colOffsets[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(totalCols, lo + BUFFER_COLS);
  }, [scrollLeft, containerSize.width, colOffsets, visibleColStart, totalCols]);

  // --- Raw cell value (checks optimistic overrides first, then row data) ---
  const getRawCellValue = useCallback(
    (col: number, row: number): string => {
      const optimistic = optimisticCellsRef.current.get(`${col},${row}`);
      if (optimistic !== undefined) return optimistic;
      const bc = sortedCols[col];
      const br = rowByPosition.get(row);
      if (!bc || !br) return '';
      return plainCellText(br.data?.[bc.id]);
    },
    [sortedCols, rowByPosition]
  );

  // --- Formula-aware cell getter (evaluates formulas) ---
  const getEvaluatedValue = useCallback(
    (col: number, row: number): string => {
      const raw = getRawCellValue(col, row);
      if (!isFormula(raw)) return raw;
      const result = evaluate(raw, (c, r) => {
        const v = getRawCellValue(c, r);
        if (isFormula(v)) {
          const res = evaluate(v, (c2, r2) => getRawCellValue(c2, r2), new Set([`${c},${r}`]));
          return res;
        }
        return v;
      }, new Set([`${col},${row}`]));
      return String(result ?? '');
    },
    [getRawCellValue]
  );

  // --- Commit ---
  const commitValue = useCallback(
    async (col: number, row: number, value: string) => {
      const bc = sortedCols[col];
      const br = rowByPosition.get(row);
      const runs = editingRunsRef.current;
      const hasRichText = runs.length > 0 && !isPlainRuns(runs);

      if (!bc) {
        if (value) {
          optimisticCellsRef.current.set(`${col},${row}`, value);
          setPendingWrite({ col, row, value });
          createColumnsUpTo(sortedCols.length, col, onCreateColumn);
        }
        return;
      }
      if (!br) {
        if (value) {
          optimisticCellsRef.current.set(`${col},${row}`, value);
          onCreateRow({ data: buildNewRowData(bc.id, value, hasRichText ? runs : null), position: row });
        }
        return;
      }
      const old = plainCellText(br.data?.[bc.id]);
      if (value === old && !hasRichText) return;
      optimisticCellsRef.current.set(`${col},${row}`, value);
      const updateData: Record<string, CellDataValue> = {
        [bc.id]: value || null,
        [richTextKey(bc.id)]: hasRichText ? runs : null,
      };
      await onUpdateRow(br.id, updateData);
    },
    [sortedCols, rowByPosition, onUpdateRow, onCreateRow, onCreateColumn, editingRunsRef]
  );

  // --- Select cell ---
  const selectCell = useCallback(
    (col: number, row: number, startEdit = false) => {
      if (isEditingRef.current && selectedCellRef.current) {
        void commitValue(selectedCellRef.current.col, selectedCellRef.current.row, editValueRef.current);
      }
      onSelectedCellChange({ col, row });
      onSelectionEndChange({ col, row });
      const raw = getRawCellValue(col, row);
      onEditValueChange(raw);
      // Load rich text runs for the cell
      const br = rowByPosition.get(row);
      const bc = sortedCols[col];
      const rt = br && bc ? getRichText(br.data, bc.id) : undefined;
      editingRunsRef.current = rt || [];
      if (startEdit) {
        onIsEditingChange(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      } else {
        onIsEditingChange(false);
        requestAnimationFrame(() => containerRef.current?.focus());
      }
    },
    [commitValue, getRawCellValue, onSelectedCellChange, onSelectionEndChange, onEditValueChange, onIsEditingChange, rowByPosition, sortedCols, editingRunsRef]
  );

  const startEditing = useCallback((initialChar?: string) => {
    onIsEditingChange(true);
    if (initialChar !== undefined) {
      onEditValueChange(initialChar);
      editingRunsRef.current = runsFromPlainText(initialChar);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [onIsEditingChange, onEditValueChange, editingRunsRef]);

  // --- Mouse handlers ---
  const getCoordsFromEvent = useCallback((e: React.MouseEvent | MouseEvent): CellCoord | null => {
    const el = (e.target as HTMLElement).closest('[data-col]') as HTMLElement | null;
    if (!el) return null;
    return { col: +el.dataset.col!, row: +el.dataset.row! };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const coords = getCoordsFromEvent(e);
    if (!coords) return;

    // If clicking inside the cell that's already being edited, let the browser
    // handle it natively — caret placement, click-drag to select, double-click
    // to select a word, triple-click to select all — exactly like Google Sheets.
    const editingCell = selectedCellRef.current;
    if (
      isEditingRef.current &&
      editingCell?.col === coords.col &&
      editingCell.row === coords.row
    ) {
      return;
    }

    e.preventDefault();

    if (e.shiftKey && selectedCellRef.current) {
      onSelectionEndChange(coords);
      onIsEditingChange(false);
      containerRef.current?.focus();
      return;
    }

    if (isEditingRef.current && selectedCellRef.current) {
      void commitValue(selectedCellRef.current.col, selectedCellRef.current.row, editValueRef.current);
    }

    onSelectedCellChange(coords);
    onSelectionEndChange(coords);
    isDraggingRef.current = true;
    const raw = getRawCellValue(coords.col, coords.row);
    onEditValueChange(raw);
    onIsEditingChange(false);
    containerRef.current?.focus();
  }, [commitValue, getRawCellValue, getCoordsFromEvent, onSelectedCellChange, onSelectionEndChange, onEditValueChange, onIsEditingChange]);

  const handleCellDoubleClick = useCallback((e: React.MouseEvent) => {
    const coords = getCoordsFromEvent(e);
    if (!coords) return;
    // If we're already editing this exact cell, let the browser handle the
    // double-click natively so it selects the word under the cursor — exactly
    // like Google Sheets. Intercepting here would reset the caret to the end.
    const sel = selectedCellRef.current;
    if (isEditingRef.current && sel?.col === coords.col && sel.row === coords.row) {
      return;
    }
    e.preventDefault();
    const raw = getRawCellValue(coords.col, coords.row);
    onSelectedCellChange(coords);
    onSelectionEndChange(coords);
    onEditValueChange(raw);
    onIsEditingChange(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [getCoordsFromEvent, getRawCellValue, onSelectedCellChange, onSelectionEndChange, onEditValueChange, onIsEditingChange]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const coords = getCoordsFromEvent(e);
    if (!coords) return;

    if (isFillDraggingRef.current) {
      const sel = selBoundsRef.current;
      if (!sel) return;
      const constrained = constrainFillCoord(coords, sel);
      if (!sameCoord(constrained, fillDragEndRef.current)) {
        setFillDragEnd(constrained);
      }
      return;
    }

    if (!isDraggingRef.current) return;
    const anchor = selectedCellRef.current;
    if (!anchor) return;
    if (!sameCoord(coords, selectionEndRef.current)) {
      onSelectionEndChange(coords);
      if (!sameCoord(coords, anchor)) {
        onIsEditingChange(false);
      }
    }
  }, [getCoordsFromEvent, onSelectionEndChange, onIsEditingChange]);

  // --- Fill handle ---
  const handleFillHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isFillDraggingRef.current = true;
    setFillDragEnd(null);
  }, []);

  const applyFill = useCallback(() => {
    const sel = selBoundsRef.current;
    const fillEnd = fillDragEndRef.current;
    if (!sel || !fillEnd) return;

    const fillMinCol = Math.min(sel.minCol, fillEnd.col);
    const fillMaxCol = Math.max(sel.maxCol, fillEnd.col);
    const fillMinRow = Math.min(sel.minRow, fillEnd.row);
    const fillMaxRow = Math.max(sel.maxRow, fillEnd.row);

    // Detect number sequence pattern along the fill axis
    const isVertical = fillMaxRow > sel.maxRow || fillMinRow < sel.minRow;
    const sequence = detectFillSequence(collectFillSeedValues(sel, isVertical, getRawCellValue));

    for (let r = fillMinRow; r <= fillMaxRow; r++) {
      for (let c = fillMinCol; c <= fillMaxCol; c++) {
        if (isInsideRange(sel, c, r)) continue;
        void commitValue(c, r, fillCellValue(sel, sequence, isVertical, c, r, getRawCellValue));
      }
    }

    if (selectedCellRef.current) {
      onSelectionEndChange(fillEnd);
    }
    setFillDragEnd(null);
  }, [getRawCellValue, commitValue, onSelectionEndChange]);

  useEffect(() => {
    const up = () => {
      if (isFillDraggingRef.current) {
        isFillDraggingRef.current = false;
        applyFill();
      }
      isDraggingRef.current = false;
      if (resizeStartRef.current) {
        const { col, startWidth } = resizeStartRef.current;
        const newWidth = colWidths[col] ?? startWidth;
        resizeStartRef.current = null;
        if (onUpdateColumn && sortedCols[col]) {
          onUpdateColumn(sortedCols[col].id, { width: newWidth });
        }
      }
      if (rowResizeStartRef.current) {
        rowResizeStartRef.current = null;
      }
    };
    const move = (e: MouseEvent) => {
      if (resizeStartRef.current) {
        const { col, startX, startWidth } = resizeStartRef.current;
        const delta = e.clientX - startX;
        const newWidth = Math.max(MIN_COL_WIDTH, startWidth + delta);
        setColWidths(prev => ({ ...prev, [col]: newWidth }));
      }
      if (rowResizeStartRef.current) {
        const { row, startY, startHeight } = rowResizeStartRef.current;
        const delta = e.clientY - startY;
        const newHeight = Math.max(ROW_HEIGHT, startHeight + delta);
        setRowHeights(prev => ({ ...prev, [row]: newHeight }));
      }
    };
    window.addEventListener('mouseup', up);
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('mousemove', move); };
  }, [applyFill, colWidths, sortedCols, onUpdateColumn]);

  // --- Column resize ---
  const handleResizeMouseDown = useCallback((e: React.MouseEvent, ci: number) => {
    e.preventDefault();
    e.stopPropagation();
    const width = getColWidth(ci);
    resizeStartRef.current = { col: ci, startX: e.clientX, startWidth: width };
  }, [getColWidth]);

  // --- Column header rename ---
  const handleHeaderDoubleClick = useCallback((ci: number) => {
    const col = sortedCols[ci];
    if (!col) return;
    setEditingHeader(ci);
    setHeaderEditValue(col.name);
    requestAnimationFrame(() => headerInputRef.current?.focus());
  }, [sortedCols]);

  const commitHeaderRename = useCallback(() => {
    if (editingHeader !== null && headerEditValue.trim() && onUpdateColumn) {
      const col = sortedCols[editingHeader];
      if (col && headerEditValue.trim() !== col.name) {
        onUpdateColumn(col.id, { name: headerEditValue.trim() });
      }
    }
    setEditingHeader(null);
  }, [editingHeader, headerEditValue, sortedCols, onUpdateColumn]);

  // --- Copy/Paste ---
  const handleCopy = useCallback(async () => {
    const sel = selBoundsRef.current;
    if (!sel) return;
    const lines: string[] = [];
    const cells: Array<{ relCol: number; relRow: number; value: string; display: string; format?: CellFormat }> = [];
    for (let r = sel.minRow; r <= sel.maxRow; r++) {
      const row: string[] = [];
      for (let c = sel.minCol; c <= sel.maxCol; c++) {
        const v = getRawCellValue(c, r);
        row.push(v);
        const br = rowByPosition.get(r);
        const bc = sortedCols[c];
        cells.push({
          relCol: c - sel.minCol,
          relRow: r - sel.minRow,
          value: v,
          display: isFormula(v) ? getEvaluatedValue(c, r) : v,
          format: br && bc ? getCellFormat(br.data, bc.id) : undefined,
        });
      }
      lines.push(row.join('\t'));
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* clipboard denied */ }
    internalClipboard = {
      text,
      width: sel.maxCol - sel.minCol + 1,
      height: sel.maxRow - sel.minRow + 1,
      cells,
    };
  }, [getRawCellValue, getEvaluatedValue, rowByPosition, sortedCols]);

  const handlePaste = useCallback(async () => {
    const cell = selectedCellRef.current;
    if (!cell) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch { return; }

    // Use internal clipboard if text matches (preserves formulas)
    if (internalClipboard?.text === text) {
      for (const c of internalClipboard.cells) {
        const targetCol = cell.col + c.relCol;
        const targetRow = cell.row + c.relRow;
        let value = c.value;
        if (isFormula(value)) {
          value = adjustFormula(value, c.relRow, c.relCol);
        }
        void commitValue(targetCol, targetRow, value);
      }
    } else {
      // Parse TSV from clipboard
      const lines = text.split('\n');
      for (let ri = 0; ri < lines.length; ri++) {
        const cols = lines[ri].split('\t');
        for (let ci = 0; ci < cols.length; ci++) {
          void commitValue(cell.col + ci, cell.row + ri, cols[ci] ?? '');
        }
      }
    }
  }, [commitValue]);

  // Blank every cell in the current selection.
  const clearSelectedCells = useCallback(() => {
    const sel = selBoundsRef.current;
    if (!sel) return;
    for (let r = sel.minRow; r <= sel.maxRow; r++) {
      for (let c = sel.minCol; c <= sel.maxCol; c++) {
        void commitValue(c, r, '');
      }
    }
  }, [commitValue]);

  const handleCut = useCallback(async () => {
    await handleCopy();
    clearSelectedCells();
  }, [handleCopy, clearSelectedCells]);

  // Paste special → Values only: pastes evaluated values, never formulas.
  const handlePasteValuesOnly = useCallback(async () => {
    const cell = selectedCellRef.current;
    if (!cell) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch { return; }

    if (internalClipboard?.text === text) {
      for (const c of internalClipboard.cells) {
        void commitValue(cell.col + c.relCol, cell.row + c.relRow, c.display);
      }
    } else {
      const lines = text.split('\n');
      for (let ri = 0; ri < lines.length; ri++) {
        const cols = lines[ri].split('\t');
        for (let ci = 0; ci < cols.length; ci++) {
          void commitValue(cell.col + ci, cell.row + ri, cols[ci] ?? '');
        }
      }
    }
  }, [commitValue]);

  // Set (not toggle) the format of a single cell — used by "Paste format only".
  const setCellFormat = useCallback(
    (col: number, row: number, format: CellFormat | undefined) => {
      const bc = sortedCols[col];
      if (!bc) return;
      const br = rowByPosition.get(row);
      const key = formatKey(bc.id);
      if (br) {
        void onUpdateRow(br.id, { [key]: format ?? null });
      } else if (format) {
        onCreateRow({ data: { [key]: format }, position: row });
      }
    },
    [sortedCols, rowByPosition, onUpdateRow, onCreateRow]
  );

  // Paste special → Format only: copies just the cell styling, leaving values.
  const handlePasteFormatOnly = useCallback(() => {
    const cell = selectedCellRef.current;
    if (!cell || !internalClipboard) return;
    for (const c of internalClipboard.cells) {
      setCellFormat(cell.col + c.relCol, cell.row + c.relRow, c.format);
    }
  }, [setCellFormat]);

  // Paste special → Formula only: pastes raw cell contents (formulas preserved,
  // references adjusted) without carrying over any formatting.
  const handlePasteFormulaOnly = useCallback(async () => {
    await handlePaste();
  }, [handlePaste]);

  // Paste special → Transposed: rows become columns and vice versa.
  const handlePasteTransposed = useCallback(async () => {
    const cell = selectedCellRef.current;
    if (!cell) return;
    if (internalClipboard) {
      for (const c of internalClipboard.cells) {
        // swap the relative axes
        void commitValue(cell.col + c.relRow, cell.row + c.relCol, c.value);
      }
      return;
    }
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch { return; }
    const lines = text.split('\n');
    for (let ri = 0; ri < lines.length; ri++) {
      const cols = lines[ri].split('\t');
      for (let ci = 0; ci < cols.length; ci++) {
        void commitValue(cell.col + ri, cell.row + ci, cols[ci] ?? '');
      }
    }
  }, [commitValue]);

  // Expose clipboard actions to the context menu
  useEffect(() => {
    if (!clipboardApiRef) return;
    clipboardApiRef.current = {
      copy: handleCopy,
      cut: handleCut,
      paste: handlePaste,
      pasteValuesOnly: handlePasteValuesOnly,
      pasteFormatOnly: handlePasteFormatOnly,
      pasteFormulaOnly: handlePasteFormulaOnly,
      pasteTransposed: handlePasteTransposed,
    };
    return () => { clipboardApiRef.current = null; };
  }, [clipboardApiRef, handleCopy, handleCut, handlePaste, handlePasteValuesOnly, handlePasteFormatOnly, handlePasteFormulaOnly, handlePasteTransposed]);

  // --- Context menu ---
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onContextMenu) return;
    const target = e.target as HTMLElement;

    // Check if right-clicking a column header
    const headerEl = target.closest('[data-col-header]') as HTMLElement | null;
    if (headerEl) {
      e.preventDefault();
      onContextMenu(e, 'column-header', { col: +headerEl.dataset.colHeader!, row: 0 });
      return;
    }

    // Check if right-clicking a row number
    const rowNumEl = target.closest('[data-row-number]') as HTMLElement | null;
    if (rowNumEl) {
      e.preventDefault();
      onContextMenu(e, 'row-number', { col: 0, row: +rowNumEl.dataset.rowNumber! });
      return;
    }

    // Check if right-clicking a cell
    const cellEl = target.closest('[data-col]') as HTMLElement | null;
    if (cellEl) {
      e.preventDefault();
      const coord = { col: +cellEl.dataset.col!, row: +cellEl.dataset.row! };
      // Match Google Sheets: right-clicking a cell outside the current
      // selection moves the selection to it, so context-menu actions
      // (insert note/link/dropdown, convert to table, filter, …) target the
      // cell the user actually clicked rather than a stale selection.
      const sel = selBoundsRef.current;
      const insideSelection = sel && isInsideRange(sel, coord.col, coord.row);
      if (!insideSelection) {
        onSelectedCellChange(coord);
        onSelectionEndChange(coord);
      }
      onContextMenu(e, 'cell', coord);
      return;
    }
  }, [onContextMenu, onSelectedCellChange, onSelectionEndChange]);

  // Callbacks handed to the cell that is being edited.
  const handleRunsChange = useCallback(
    (runs: RichTextRun[]) => {
      editingRunsRef.current = runs;
    },
    [editingRunsRef]
  );

  const handleSelectionInfo = useCallback(
    (info: { start: number; end: number }) => {
      setInlineSelection(info);
      onInlineSelectionChange?.(info);
    },
    [onInlineSelectionChange]
  );

  // --- Keyboard ---
  // Ctrl/Cmd+B / +I: format the selection (while editing, contentEditable handles it natively
  // and onInput parses the result).
  const formatSelection = useCallback(
    (e: React.KeyboardEvent, format: Partial<CellFormat>) => {
      if (isEditingRef.current) return;
      e.preventDefault();
      const sel = selBoundsRef.current;
      if (onFormatCells && sel) {
        onFormatCells(collectSelectionCells(sel, rowByPosition, sortedCols), format);
      }
    },
    [onFormatCells, rowByPosition, sortedCols]
  );

  const handleCtrlShortcut = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key.toLowerCase()) {
        case 'c':
          e.preventDefault();
          void handleCopy();
          break;
        case 'v':
          e.preventDefault();
          void handlePaste();
          break;
        case 'x':
          e.preventDefault();
          void handleCut();
          break;
        case 'b':
          formatSelection(e, { bold: true });
          break;
        case 'i':
          formatSelection(e, { italic: true });
          break;
        case 'home':
          // Ctrl+Home -> go to A1
          e.preventDefault();
          selectCell(0, 0);
          break;
        default:
          break;
      }
    },
    [handleCopy, handlePaste, handleCut, formatSelection, selectCell]
  );

  // Tab / Enter / Escape, active both while editing and while browsing. Returns true when handled.
  const handleCommitKey = useCallback(
    (e: React.KeyboardEvent, cell: CellCoord): boolean => {
      const { col, row } = cell;
      switch (e.key) {
        case 'Tab':
          e.preventDefault();
          if (isEditingRef.current) void commitValue(col, row, editValueRef.current);
          selectCell(e.shiftKey ? Math.max(0, col - 1) : Math.min(totalCols - 1, col + 1), row);
          return true;
        case 'Enter':
          e.preventDefault();
          if (isEditingRef.current) {
            void commitValue(col, row, editValueRef.current);
            selectCell(col, Math.min(totalRows - 1, row + 1));
          } else {
            startEditing();
          }
          return true;
        case 'Escape':
          e.preventDefault();
          onEditValueChange(getRawCellValue(col, row));
          onIsEditingChange(false);
          containerRef.current?.focus();
          return true;
        default:
          return false;
      }
    },
    [totalCols, totalRows, commitValue, selectCell, getRawCellValue, startEditing, onEditValueChange, onIsEditingChange]
  );

  // Navigation and typing keys, only used while not editing a cell.
  const handleBrowseKey = useCallback(
    (e: React.KeyboardEvent, cell: CellCoord) => {
      const isArrow = e.key.startsWith('Arrow');
      if (e.shiftKey && isArrow) {
        e.preventDefault();
        const end = selectionEndRef.current || cell;
        onSelectionEndChange(arrowStep(e.key, end, totalCols - 1, totalRows - 1) ?? { ...end });
        return;
      }

      const target = arrowStep(e.key, cell, totalCols - 1, totalRows - 1);
      if (target) {
        e.preventDefault();
        selectCell(target.col, target.row);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        clearSelectedCells();
        onEditValueChange('');
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        startEditing();
        return;
      }
      if (e.key.length === 1 && !e.altKey) {
        e.preventDefault();
        onSelectionEndChange(cell);
        startEditing(e.key);
      }
    },
    [totalCols, totalRows, selectCell, clearSelectedCells, startEditing, onEditValueChange, onSelectionEndChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        handleCtrlShortcut(e);
        return;
      }

      const cell = selectedCellRef.current;
      if (!cell) return;
      if (handleCommitKey(e, cell)) return;
      if (!isEditingRef.current) handleBrowseKey(e, cell);
    },
    [handleCtrlShortcut, handleCommitKey, handleBrowseKey]
  );


  // Apply pending write once the target column exists
  useEffect(() => {
    if (!pendingWrite) return;
    const { col, row, value } = pendingWrite;
    const bc = sortedCols[col];
    if (!bc) return; // Column not created yet, wait for next update
    setPendingWrite(null);
    const br = rowByPosition.get(row);
    if (br) {
      void onUpdateRow(br.id, { [bc.id]: value || null });
    } else if (value) {
      onCreateRow({ data: { [bc.id]: value }, position: row });
    }
  }, [sortedCols, pendingWrite, rowByPosition, onUpdateRow, onCreateRow]);

  // --- Selection geometry ---
  const selBounds = useMemo<NormalizedRange | null>(() => {
    if (!selectedCell || !selectionEnd) return null;
    return normRange({ start: selectedCell, end: selectionEnd });
  }, [selectedCell, selectionEnd]);

  const selBoundsRef = useRef(selBounds);
  selBoundsRef.current = selBounds;

  const isMulti = selBounds
    ? selBounds.minCol !== selBounds.maxCol || selBounds.minRow !== selBounds.maxRow
    : false;

  const HEADER_H = ROW_HEIGHT;

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto bg-background outline-none select-none"
      role="grid"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      onContextMenu={handleContextMenu}
      style={{ position: 'relative' }}
    >
      <div style={{ width: totalWidth, minWidth: '100%', height: totalHeight + HEADER_H, position: 'relative' }}>
        {/* Column headers (sticky) */}
        <div className="sticky top-0 z-20" style={{ height: HEADER_H, position: 'sticky' }}>
          <div style={{ position: 'relative', height: HEADER_H }}>
            {/* Corner cell */}
            <div
              className="z-30 border-r border-b border-border bg-[#f8f9fa] dark:bg-muted/50"
              style={{ position: 'sticky', left: 0, top: 0, width: ROW_NUM_WIDTH, height: HEADER_H, float: 'left' }}
            />
            {/* Visible column headers */}
            {Array.from({ length: visibleColEnd - visibleColStart }).map((_, i) => {
              const ci = visibleColStart + i;
              const w = getColWidth(ci);
              const left = ROW_NUM_WIDTH + colOffsets[ci];
              const isSelected = selBounds && ci >= selBounds.minCol && ci <= selBounds.maxCol;
              const isEditingThis = editingHeader === ci;

              return (
                <div
                  key={ci}
                  role="presentation"
                  data-col-header={ci}
                  className={`border-r border-b border-border flex items-center justify-center text-[11px] font-medium select-none ${
                    isSelected ? 'bg-[#d3e3fd] dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'bg-[#f8f9fa] dark:bg-muted/50 text-muted-foreground'
                  }`}
                  style={{ position: 'absolute', left, top: 0, width: w, height: HEADER_H }}
                  onDoubleClick={() => handleHeaderDoubleClick(ci)}
                >
                  {isEditingThis ? (
                    <input
                      ref={headerInputRef}
                      value={headerEditValue}
                      onChange={(e) => setHeaderEditValue(e.target.value)}
                      onBlur={commitHeaderRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitHeaderRename();
                        if (e.key === 'Escape') setEditingHeader(null);
                      }}
                      className="w-full h-full text-[11px] text-center bg-white dark:bg-background outline-none border-none"
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    colLabel(ci)
                  )}
                  {/* Filter funnel — shown when a filter covers this column */}
                  {filter?.active &&
                    ci >= filter.minCol &&
                    ci <= filter.maxCol &&
                    sortedCols[ci] &&
                    onFilterClick && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={`absolute right-[6px] top-1/2 -translate-y-1/2 flex h-3.5 w-3.5 items-center justify-center rounded-sm hover:bg-blue-500/20 ${
                          filter.criteria[sortedCols[ci].id]?.length ? 'text-blue-600' : 'text-muted-foreground'
                        }`}
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onFilterClick(ci, (e.currentTarget as HTMLElement).getBoundingClientRect());
                        }}
                      >
                        <Filter className="h-2.5 w-2.5" fill={filter.criteria[sortedCols[ci].id]?.length ? 'currentColor' : 'none'} />
                      </Button>
                    )}
                  {/* Resize handle */}
                  <div
                    role="presentation"
                    className="absolute top-0 right-0 w-[4px] h-full cursor-col-resize hover:bg-blue-400/50"
                    onMouseDown={(e) => handleResizeMouseDown(e, ci)}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Grid body */}
        <div
          role="presentation"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onDoubleClick={handleCellDoubleClick}
          style={{ position: 'relative' }}
        >
          {/* Row numbers (sticky left) */}
          <div style={{ position: 'sticky', left: 0, zIndex: 10, width: ROW_NUM_WIDTH, height: 0, float: 'left' }}>
            {Array.from({ length: visibleRowEnd - visibleRowStart }).map((_, i) => {
              const ri = visibleRowStart + i;
              if (getRowHeight(ri) === 0) return null; // collapsed by filter
              const isSelected = selBounds && ri >= selBounds.minRow && ri <= selBounds.maxRow;
              return (
                <div
                  key={ri}
                  data-row-number={ri}
                  className={`border-r border-b border-border flex items-center justify-center text-[11px] font-medium ${
                    isSelected ? 'bg-[#d3e3fd] dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'bg-[#f8f9fa] dark:bg-muted/50 text-muted-foreground'
                  }`}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: rowOffsets[ri],
                    width: ROW_NUM_WIDTH,
                    height: getRowHeight(ri),
                  }}
                >
                  {ri + 1}
                  {/* Row resize handle */}
                  <div
                    role="presentation"
                    className="absolute left-0 right-0 bottom-0 h-[3px] cursor-row-resize hover:bg-blue-400/50 z-20"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      rowResizeStartRef.current = { row: ri, startY: e.clientY, startHeight: getRowHeight(ri) };
                    }}
                  />
                </div>
              );
            })}
          </div>

          {/* Visible cells */}
          {Array.from({ length: visibleRowEnd - visibleRowStart }).map((_, ri_offset) => {
            const ri = visibleRowStart + ri_offset;
            if (getRowHeight(ri) === 0) return null; // collapsed by filter
            return Array.from({ length: visibleColEnd - visibleColStart }).map((_, ci_offset) => {
              const ci = visibleColStart + ci_offset;
              // Merge handling: skip cells covered by (but not anchoring) a merge;
              // the anchor cell is widened/heightened to span the whole range.
              const merge = findMerge(ci, ri);
              if (isCoveredByMerge(merge, ci, ri)) return null;
              const isAnchor = sameCoord({ col: ci, row: ri }, selectedCell);
              const isEditingThis = isAnchor && isEditing && !isMulti;
              const rawValue = getRawCellValue(ci, ri);
              const displayValue = isFormula(rawValue) ? getEvaluatedValue(ci, ri) : rawValue;

              // Get formatting
              const bc = sortedCols[ci];
              const { fmt, rt, note: cellNote, link: cellLink } = getCellExtras(rowByPosition.get(ri), bc);
              const cellStyle = getCellStyle(fmt);
              const formattedValue = fmt?.numberFormat ? formatCellDisplay(displayValue, fmt) : displayValue;
              const dropdownOptions = getDropdownOptions(bc);
              const modeProps = isEditingThis
                ? { onRichTextChange: handleRunsChange, onSelectionInfo: handleSelectionInfo }
                : { link: cellLink };

              const w = merge ? colOffsets[merge.maxCol + 1] - colOffsets[merge.minCol] : getColWidth(ci);
              const cellH = merge ? rowOffsets[merge.maxRow + 1] - rowOffsets[merge.minRow] : getRowHeight(ri);

              return (
                <div
                  key={`${ci}-${ri}`}
                  data-col={ci}
                  data-row={ri}
                  className="border-r border-b border-border cursor-cell"
                  style={{
                    position: 'absolute',
                    left: ROW_NUM_WIDTH + colOffsets[ci],
                    top: rowOffsets[ri],
                    width: w,
                    height: cellH,
                    zIndex: merge ? 5 : undefined,
                    backgroundColor: fmt?.fillColor || undefined,
                  }}
                >
                  {dropdownOptions && !isEditingThis ? (
                    <DropdownChip
                      value={displayValue}
                      options={dropdownOptions}
                      height={cellH}
                      onOpen={(rect) => setOpenDropdown({ col: ci, row: ri, x: rect.left, y: rect.bottom + 2, options: dropdownOptions })}
                    />
                  ) : (
                    <Cell
                      displayValue={formattedValue}
                      isEditing={isEditingThis}
                      editValue={editValue}
                      onEditChange={onEditValueChange}
                      inputRef={inputRef}
                      cellStyle={cellStyle}
                      align={getDefaultAlign(displayValue, fmt)}
                      isError={isErrorDisplayValue(displayValue)}
                      cellHeight={cellH}
                      richTextRuns={rt}
                      {...modeProps}
                      note={cellNote}
                    />
                  )}
                </div>
              );
            });
          })}

          {/* Selection overlay */}
          {selBounds && (
            <>
              {isMulti && (
                <div
                  className="pointer-events-none absolute bg-[#1a73e8]/10"
                  style={{
                    left: ROW_NUM_WIDTH + colOffsets[selBounds.minCol],
                    top: rowOffsets[selBounds.minRow],
                    width: colOffsets[selBounds.maxCol + 1] - colOffsets[selBounds.minCol],
                    height: rowOffsets[selBounds.maxRow + 1] - rowOffsets[selBounds.minRow],
                    zIndex: 12,
                  }}
                />
              )}
              <div
                className="pointer-events-none absolute"
                style={{
                  left: ROW_NUM_WIDTH + colOffsets[selBounds.minCol] - 1,
                  top: rowOffsets[selBounds.minRow] - 1,
                  width: colOffsets[selBounds.maxCol + 1] - colOffsets[selBounds.minCol] + 1,
                  height: rowOffsets[selBounds.maxRow + 1] - rowOffsets[selBounds.minRow] + 1,
                  border: '2px solid #1a73e8',
                  zIndex: 15,
                }}
              >
                <div
                  role="presentation"
                  className="absolute bg-[#1a73e8]"
                  style={{ width: 6, height: 6, right: -4, bottom: -4, cursor: 'crosshair', pointerEvents: 'auto' }}
                  onMouseDown={handleFillHandleMouseDown}
                />
              </div>
              {isMulti && selectedCell && (
                <div
                  className="pointer-events-none absolute bg-background"
                  style={{
                    left: ROW_NUM_WIDTH + colOffsets[selectedCell.col],
                    top: rowOffsets[selectedCell.row],
                    width: getColWidth(selectedCell.col) - 1,
                    height: getRowHeight(selectedCell.row) - 1,
                    zIndex: 14,
                  }}
                />
              )}
            </>
          )}

          {/* Fill drag preview */}
          {fillDragEnd && selBounds && (() => {
            const fillMinCol = Math.min(selBounds.minCol, fillDragEnd.col);
            const fillMaxCol = Math.max(selBounds.maxCol, fillDragEnd.col);
            const fillMinRow = Math.min(selBounds.minRow, fillDragEnd.row);
            const fillMaxRow = Math.max(selBounds.maxRow, fillDragEnd.row);
            return (
              <>
                <div
                  className="pointer-events-none absolute bg-[#1a73e8]/8"
                  style={{
                    left: ROW_NUM_WIDTH + colOffsets[fillMinCol],
                    top: rowOffsets[fillMinRow],
                    width: colOffsets[fillMaxCol + 1] - colOffsets[fillMinCol],
                    height: rowOffsets[fillMaxRow + 1] - rowOffsets[fillMinRow],
                    zIndex: 13,
                  }}
                />
                <div
                  className="pointer-events-none absolute"
                  style={{
                    left: ROW_NUM_WIDTH + colOffsets[fillMinCol] - 1,
                    top: rowOffsets[fillMinRow] - 1,
                    width: colOffsets[fillMaxCol + 1] - colOffsets[fillMinCol] + 1,
                    height: rowOffsets[fillMaxRow + 1] - rowOffsets[fillMinRow] + 1,
                    border: '2px dashed #1a73e8',
                    zIndex: 16,
                  }}
                />
              </>
            );
          })()}
        </div>
      </div>

      {/* Dropdown (data-validation list) picker */}
      {openDropdown && (
        <>
          <div role="presentation" className="fixed inset-0 z-40" onMouseDown={() => setOpenDropdown(null)} />
          <div
            role="presentation"
            className="fixed z-50 max-h-60 w-44 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            style={{ left: Math.min(openDropdown.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 190), top: openDropdown.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              className="flex w-full items-center rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
              onClick={() => { void commitValue(openDropdown.col, openDropdown.row, ''); setOpenDropdown(null); }}
            >
              —
            </Button>
            {openDropdown.options.map((opt) => (
              <Button
                key={opt}
                variant="ghost"
                className="flex w-full items-center rounded px-2 py-1 text-left text-sm hover:bg-accent"
                onClick={() => { void commitValue(openDropdown.col, openDropdown.row, opt); setOpenDropdown(null); }}
              >
                <span
                  className="truncate rounded-full px-2 py-0.5 text-[11px] leading-none text-gray-800"
                  style={{ backgroundColor: optionColor(openDropdown.options, opt) || '#e5e7eb' }}
                >
                  {opt}
                </span>
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
