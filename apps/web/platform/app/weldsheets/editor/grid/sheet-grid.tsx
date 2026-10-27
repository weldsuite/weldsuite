import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { fillTarget } from '../model/autofill';
import { copySelection, moveCells, pasteInto } from '../model/clipboard';
import { acceptsReference, functionPrefixAt, isFormulaText, referenceText, refsInEdit, suggestFunctions } from '../model/formula-edit';
import { handleEditKey, handleGridKey } from '../model/keyboard';
import { MAX_COLS, MAX_ROWS, type Chart, type Range } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';
import { chartAt, draggedChart, HANDLE_CURSOR, samePlace, type ChartHandle } from '../charts/chart-geometry';
import { removeChart, saveChart } from '../model/charts';
import {
  cellSelection,
  clampToGrid,
  extendTo,
  isWholeColumns,
  isWholeRows,
  primaryRange,
  rangeFrom,
  selectionContains,
  wholeColumns,
  wholeRows,
  type CellPos,
} from '../model/selection';
import type { SheetController } from '../model/sheet-controller';
import { fitToData } from './autofit';
import { GridContextMenu } from './grid-context-menu';
import { TableChip } from './table-chip';
import {
  colLeft,
  computeLayout,
  hitTest,
  physicalScrollSize,
  rangeRect,
  rowHeaderWidth,
  rowTop,
  scrollContentSize,
  scrollIntoView,
  toLogicalScroll,
  toPhysicalScroll,
  COL_HEADER_HEIGHT,
  type GridLayout,
  type Hit,
  type Rect,
} from './geometry';
import {
  checkboxRect,
  dropdownRect,
  fillHandleCenter,
  filterButtonRect,
  fontFor,
  measureText,
  renderGrid,
  type RefHighlight,
  type RemoteCursor,
} from './renderer';
import { FilterMenu, ListMenu } from '../rules/cell-menus';
import { readGridTheme, REFERENCE_COLORS, type GridTheme } from './theme';

/** How long someone's name shows after they move; after that only while the pointer is on their cell. */
const NAME_LABEL_MS = 3000;

type Drag =
  | { kind: 'select'; anchor: CellPos; additive: boolean }
  | { kind: 'columns'; from: number }
  | { kind: 'rows'; from: number }
  | { kind: 'resize'; axis: 'row' | 'col'; index: number; startPos: number; startSize: number; size: number }
  | { kind: 'point'; anchor: CellPos; start: number; end: number }
  | { kind: 'chart'; chart: Chart; handle: ChartHandle | null; startX: number; startY: number; preview: Chart | null }
  /** The fill handle: `target` is where it would fill, `toggle` whether Ctrl is held (copy instead of a series). */
  | { kind: 'fill'; source: Range; target: Range; toggle: boolean }
  /** A block dragged by its outline, held at `grab` (its offset in the block); `at` is where it would land. */
  | { kind: 'move'; source: Range; grab: CellPos; at: CellPos | null; copy: boolean; down: CellPos }
  /** Selected whole rows or columns dragged by their headers, to go before `to`. */
  | { kind: 'moveDims'; axis: 'row' | 'col'; from: number; count: number; to: number | null; down: number; moved: boolean };

/** What a drag shows on the grid while it lasts. */
interface DragPreview {
  range: Range | null;
  hint: string | null;
  dim: { axis: 'row' | 'col'; at: number } | null;
}

/** Pixels around the fill handle and a selection's outline that grab them. */
const HANDLE_GRIP = 5;
const EDGE_GRIP = 3;

/** The bar under the last row that adds rows at the bottom, as in Google Sheets. */
const ADD_ROWS_HEIGHT = 48;
const ADD_ROWS_DEFAULT = '1000';
const TABLE_CHIP_HEIGHT = 22;

interface Props {
  controller: SheetController;
  /** The formula bar's input: point mode inserts references there when it is being typed in. */
  barInputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Opens the "Create pivot table" dialog (context menu). */
  onCreatePivot?: () => void;
  /** What each connected table lists, by its id: the name on its chip. */
  tableLabels?: Record<string, string>;
}

/**
 * The spreadsheet grid: a canvas under a transparent native scroller (which
 * supplies scrollbars and wheel/touch scrolling), and one textarea that is
 * both the keyboard sink and the in-cell editor.
 */
export function SheetGrid({ controller, barInputRef, onCreatePivot, tableLabels }: Props) {
  const version = useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [resizeGhost, setResizeGhost] = useState<number | null>(null);
  /** A chart being moved or resized, where it would land. */
  const [chartPreview, setChartPreview] = useState<Chart | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [caret, setCaret] = useState(0);
  /** The cell under the pointer, tracked only while someone else is on this sheet. */
  const [hoverCell, setHoverCell] = useState<CellPos | null>(null);
  /** An open filter menu (on a filter header cell) or dropdown list (on a list cell). */
  const [cellMenu, setCellMenu] = useState<{ kind: 'filter' | 'list'; row: number; col: number } | null>(null);
  const [, setLabelClock] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [addRowsCount, setAddRowsCount] = useState(ADD_ROWS_DEFAULT);
  const themeRef = useRef<GridTheme | null>(null);
  const layoutRef = useRef<GridLayout | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** Where the pointer is during a drag, and whether Ctrl (⌘) is held. */
  const pointerRef = useRef<{ clientX: number; clientY: number; mod: boolean } | null>(null);
  /** The animation frame that scrolls the grid while a drag is held past its edge. */
  const scrollFrame = useRef<number | null>(null);
  const autoScrollRef = useRef<() => void>(() => {});
  /** Ctrl+Shift+V was pressed: the paste that follows pastes values only. */
  const pasteValues = useRef(false);
  const lastActive = useRef<string>('');
  /** A table chip's menu is open: the grid leaves the focus with it. */
  const chipMenuOpen = useRef(false);

  const sheet = controller.sheet;
  const editing = controller.editing;
  const canAddRows = !controller.readOnly && sheet.rowCount < MAX_ROWS;
  // The scroll space ends past the last row by the add-rows bar.
  const cells = scrollContentSize(sheet);
  const content = { width: cells.width, height: cells.height + (canAddRows ? ADD_ROWS_HEIGHT : 0) };
  const headerW = rowHeaderWidth(sheet.rowCount);
  const frozenW = sheet.cols.offsetOf(Math.min(sheet.freeze.cols, sheet.colCount));
  const frozenH = sheet.rows.offsetOf(Math.min(sheet.freeze.rows, sheet.rowCount));
  const viewW = Math.max(0, size.width - headerW - frozenW);
  const viewH = Math.max(0, size.height - COL_HEADER_HEIGHT - frozenH);
  const layout = computeLayout(sheet, size.width, size.height, scroll.x, scroll.y);
  layoutRef.current = layout;

  // Size and theme.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(el);
    themeRef.current = readGridTheme(el);
    const themeObserver = new MutationObserver(() => {
      themeRef.current = readGridTheme(el);
      setScroll((s) => ({ ...s }));
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  // Formula references to outline while editing.
  const highlights: RefHighlight[] = editing
    ? refsInEdit(editing.text, sheet.name, controller.options.formulaLocale).map((r) => ({
        range: r.range,
        color: REFERENCE_COLORS[r.colorIndex % REFERENCE_COLORS.length]!,
      }))
    : [];

  // Where the other people in a co-edited sheet are, on this sheet.
  // Their name shows for a moment after they move (it covers the cell above
  // theirs), and while the pointer is on their cell.
  const now = Date.now();
  const hovered = hoverCell ? (sheet.mergeAt(hoverCell.row, hoverCell.col) ?? { r1: hoverCell.row, c1: hoverCell.col }) : null;
  let nextHide = Number.POSITIVE_INFINITY;
  const remote: RemoteCursor[] = controller.peers.flatMap((p) => {
    if (p.presence?.sheetId !== controller.activeSheetId) return [];
    const { active, ranges } = p.presence;
    const until = (controller.peerMovedAt(p.clientId) ?? 0) + NAME_LABEL_MS;
    if (until > now) nextHide = Math.min(nextHide, until);
    const pointedAt = hovered?.r1 === active.row && hovered.c1 === active.col;
    return [{ name: p.name, color: p.color, ranges, active, showName: until > now || pointedAt }];
  });

  // Draw again when the next name is due to hide.
  useEffect(() => {
    if (nextHide === Number.POSITIVE_INFINITY) return;
    const timer = window.setTimeout(() => setLabelClock((n) => n + 1), nextHide - Date.now() + 20);
    return () => window.clearTimeout(timer);
  }, [nextHide]);

  // Draw after every render. Renders only happen on a change (edit, selection,
  // scroll, resize), so painting synchronously is cheap and never lags a frame;
  // requestAnimationFrame would also stall while the page is in the background.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const theme = themeRef.current;
    if (!canvas || !theme || size.width === 0 || size.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.width * dpr || canvas.height !== size.height * dpr) {
      canvas.width = size.width * dpr;
      canvas.height = size.height * dpr;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderGrid(ctx, {
      layout,
      controller,
      theme,
      selection: controller.selection,
      editing: editing ? { row: editing.row, col: editing.col } : null,
      highlights,
      remote,
      chartPreview,
      emptyChartLabel: t.weldsheets.charts.noData,
      dropRange: dragPreview?.range,
      fillHint: dragPreview?.hint,
      dimDrop: dragPreview?.dim,
    });
    if (resizeGhost !== null) drawResizeGhost(ctx, layout, resizeGhost, dragRef.current, theme);
  });

  // Keep the active cell in view after keyboard moves.
  useEffect(() => {
    const { row, col } = controller.selection.active;
    const key = `${controller.activeSheetId}:${row}:${col}`;
    if (key === lastActive.current) return;
    lastActive.current = key;
    const l = layoutRef.current;
    const scroller = scrollerRef.current;
    if (!l || !scroller || l.width === 0 || dragRef.current) return;
    const next = scrollIntoView(l, sheet, row, col);
    if (!next) return;
    scroller.scrollLeft = toPhysicalScroll(next.scrollX, content.width, viewW);
    scroller.scrollTop = toPhysicalScroll(next.scrollY, content.height, viewH);
  }, [version, controller, sheet, content.width, content.height, viewW, viewH]);

  // Opening an existing value for editing puts the caret at its end.
  const wasEditing = useRef(false);
  useEffect(() => {
    const isEditing = !!controller.editing;
    if (isEditing && !wasEditing.current && controller.editing?.origin === 'cell') {
      placeCaret(controller.editing.text.length);
    }
    wasEditing.current = isEditing;
  });

  // The editor follows the active cell and keeps focus unless the formula bar has it,
  // or a field in a side panel, dialog, the find bar or the add-rows bar does (a chart panel saves as it is typed in).
  useEffect(() => {
    if (editing?.origin === 'bar' || chipMenuOpen.current) return;
    if (document.activeElement?.closest('aside, form, [role="dialog"], [role="search"]')) return;
    editorRef.current?.focus({ preventScroll: true });
  }, [version, editing?.origin]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScroll({
      x: toLogicalScroll(el.scrollLeft, content.width, viewW),
      y: toLogicalScroll(el.scrollTop, content.height, viewH),
    });
  }, [content.width, content.height, viewW, viewH]);

  const pointAt = (e: { clientX: number; clientY: number }): { hit: Hit; x: number; y: number } => {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { hit: hitTest(layoutRef.current!, sheet, x, y), x, y };
  };

  /**
   * Where a drag is over: the pointer held inside the cells (past an edge it
   * means the cell at that edge), against the scroll position as it is now,
   * which may be ahead of the last render while the grid scrolls itself.
   */
  const dragPointAt = (e: { clientX: number; clientY: number }): { hit: Hit; x: number; y: number } => {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, headerW, Math.max(headerW, size.width - 1));
    const y = clamp(e.clientY - rect.top, COL_HEADER_HEIGHT, Math.max(COL_HEADER_HEIGHT, size.height - 1));
    return { hit: hitTest(dragLayout(), sheet, x, y), x, y };
  };

  /** The layout for the scroll position the scroller has now. */
  const dragLayout = (): GridLayout => {
    const el = scrollerRef.current;
    if (!el) return layout;
    return computeLayout(sheet, size.width, size.height, toLogicalScroll(el.scrollLeft, content.width, viewW), toLogicalScroll(el.scrollTop, content.height, viewH));
  };

  /** The fill handle of the selection, while it can be dragged. */
  const onFillHandle = (x: number, y: number): boolean => {
    const source = controller.readOnly || editing ? null : controller.fillSource();
    if (!source) return false;
    const [hx, hy] = fillHandleCenter(rangeRect(layout, sheet, source));
    return Math.abs(x - hx) <= HANDLE_GRIP && Math.abs(y - hy) <= HANDLE_GRIP;
  };

  /** On the outline of the selected block (whole rows and columns excepted): grabs it to move it. */
  const onSelectionEdge = (x: number, y: number): boolean => {
    if (controller.readOnly || editing || controller.selection.ranges.length !== 1) return false;
    const primary = primaryRange(controller.selection);
    if (isWholeColumns(primary) || isWholeRows(primary)) return false;
    const r = rangeRect(layout, sheet, primary);
    const near = (a: number, b: number) => Math.abs(a - b) <= EDGE_GRIP;
    const alongX = x >= r.x - EDGE_GRIP && x <= r.x + r.w + EDGE_GRIP;
    const alongY = y >= r.y - EDGE_GRIP && y <= r.y + r.h + EDGE_GRIP;
    return (alongY && (near(x, r.x) || near(x, r.x + r.w))) || (alongX && (near(y, r.y) || near(y, r.y + r.h)));
  };

  /** A press on a header of selected whole rows or columns: picks them up to move them. */
  const onSelectedHeader = (hit: Hit): 'row' | 'col' | null => {
    if (controller.readOnly || hit.resize || controller.selection.ranges.length !== 1) return null;
    const p = primaryRange(controller.selection);
    if (hit.area === 'colHeader' && isWholeColumns(p) && !isWholeRows(p) && hit.col >= p.c1 && hit.col <= p.c2) return 'col';
    if (hit.area === 'rowHeader' && isWholeRows(p) && !isWholeColumns(p) && hit.row >= p.r1 && hit.row <= p.r2) return 'row';
    return null;
  };

  /**
   * Keeps a drag going past the edge of the grid: scrolls towards the
   * pointer each frame (faster the further out it is) and extends the drag
   * over what scrolls in. Stops when the pointer comes back or the grid
   * cannot scroll further.
   */
  autoScrollRef.current = () => {
    scrollFrame.current = null;
    const drag = dragRef.current;
    const p = pointerRef.current;
    const scroller = scrollerRef.current;
    const container = containerRef.current;
    if (!drag || !p || !scroller || !container || drag.kind === 'resize' || drag.kind === 'chart') return;
    const rect = container.getBoundingClientRect();
    const across = drag.kind !== 'rows' && !(drag.kind === 'moveDims' && drag.axis === 'row');
    const down = drag.kind !== 'columns' && !(drag.kind === 'moveDims' && drag.axis === 'col');
    const dx = across ? edgeSpeed(p.clientX - rect.left, headerW + frozenW, size.width) : 0;
    const dy = down ? edgeSpeed(p.clientY - rect.top, COL_HEADER_HEIGHT + frozenH, size.height) : 0;
    const before = [scroller.scrollLeft, scroller.scrollTop];
    scroller.scrollLeft += dx;
    scroller.scrollTop += dy;
    if (scroller.scrollLeft === before[0] && scroller.scrollTop === before[1]) return;
    dragTo(drag, dragPointAt(p));
    scrollFrame.current = requestAnimationFrame(() => autoScrollRef.current());
  };

  const stopAutoScroll = () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  };

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  const cellRect = (row: number, col: number): Rect => rangeRect(layout, sheet, sheet.mergeAt(row, col) ?? { r1: row, c1: col, r2: row, c2: col });

  /** A click on a filter button, a checkbox or a dropdown arrow: handled here instead of selecting. */
  const clickedControl = (hit: Hit, x: number, y: number): boolean => {
    if (hit.area !== 'cell' || controller.readOnly) return false;
    const cell = cellRect(hit.row, hit.col);
    const inside = (r: Rect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    const filter = sheet.filter;
    if (filter && hit.row === filter.range.r1 && hit.col >= filter.range.c1 && hit.col <= filter.range.c2 && inside(filterButtonRect(cell))) {
      setCellMenu({ kind: 'filter', row: hit.row, col: hit.col });
      return true;
    }
    const rule = controller.validationAt(hit.row, hit.col);
    if (rule?.criteria.type === 'checkbox' && inside(checkboxRect(cell))) {
      controller.select(cellSelection(hit.row, hit.col));
      controller.toggleCheckbox(hit.row, hit.col);
      return true;
    }
    const isList = rule?.criteria.type === 'list' || rule?.criteria.type === 'listRange';
    if (rule?.dropdown && isList && inside(dropdownRect(cell))) {
      controller.select(cellSelection(hit.row, hit.col));
      setCellMenu({ kind: 'list', row: hit.row, col: hit.col });
      return true;
    }
    return false;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { hit, x, y } = pointAt(e);
    if (hit.area === 'cell' && x > layout.width - 16 && y > layout.height - 16) return; // scrollbar corner
    const onChart = hit.area === 'cell' ? chartAt(layout, sheet, x, y, controller.selectedChart) : null;
    if (onChart) {
      pickChart(onChart.chart, onChart.handle ?? null, e);
      return;
    }
    if (hit.area === 'cell' && grabSelection(hit, x, y, e)) return;
    if (!editing && clickedControl(hit, x, y)) {
      e.preventDefault();
      return;
    }
    const input = activeInput();
    const caretPos = input?.selectionStart ?? 0;
    const pointing = hit.area === 'cell' && !!editing && acceptsReference(editing.text, caretPos);
    if (!pointing && !controller.commitEdit()) {
      // Refused by a strict validation rule: keep editing that cell.
      e.preventDefault();
      input?.focus({ preventScroll: true });
      return;
    }
    if (pointing) startPointMode(hit, caretPos);
    else startSelection(hit, e);
    pointerRef.current = { clientX: e.clientX, clientY: e.clientY, mod: e.ctrlKey || e.metaKey };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    (pointing ? input : editorRef.current)?.focus({ preventScroll: true });
  };

  /** A press on the fill handle starts a fill, on the selection's outline a move. False when it is on neither. */
  const grabSelection = (hit: Hit, x: number, y: number, e: React.PointerEvent<HTMLDivElement>): boolean => {
    const onHandle = onFillHandle(x, y);
    if (!onHandle && !onSelectionEdge(x, y)) return false;
    const source = clampToGrid(primaryRange(controller.selection), sheet.rowCount, sheet.colCount);
    const mod = e.ctrlKey || e.metaKey;
    if (onHandle) {
      dragRef.current = { kind: 'fill', source, target: source, toggle: mod };
    } else {
      const grab = { row: clamp(hit.row, source.r1, source.r2) - source.r1, col: clamp(hit.col, source.c1, source.c2) - source.c1 };
      dragRef.current = { kind: 'move', source, grab, at: null, copy: mod, down: { row: hit.row, col: hit.col } };
      e.currentTarget.style.cursor = 'grabbing';
    }
    pointerRef.current = { clientX: e.clientX, clientY: e.clientY, mod };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    editorRef.current?.focus({ preventScroll: true });
    return true;
  };

  /** A press on a chart picks it, and starts moving it (or resizing it, on a handle). */
  const pickChart = (chart: Chart, handle: ChartHandle | null, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!controller.commitEdit()) {
      activeInput()?.focus({ preventScroll: true });
      return;
    }
    controller.selectChart(chart.id);
    if (!controller.readOnly) {
      dragRef.current = { kind: 'chart', chart, handle, startX: e.clientX, startY: e.clientY, preview: null };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    editorRef.current?.focus({ preventScroll: true });
  };

  /** Where the current edit is typed: the formula bar or the in-cell editor. */
  const activeInput = () => (controller.editing?.origin === 'bar' ? barInputRef?.current : editorRef.current) ?? null;

  const startPointMode = (hit: Hit, caretPos: number) => {
    const edit = controller.editing!;
    const ref = referenceText({ r1: hit.row, c1: hit.col, r2: hit.row, c2: hit.col }, sheet.name, sheet.name);
    const text = edit.text.slice(0, caretPos) + ref + edit.text.slice(caretPos);
    controller.updateEdit(text);
    dragRef.current = { kind: 'point', anchor: { row: hit.row, col: hit.col }, start: caretPos, end: caretPos + ref.length };
    placeCaret(caretPos + ref.length);
  };

  const startResize = ({ axis, index }: NonNullable<Hit['resize']>, e: React.PointerEvent) => {
    const startSize = axis === 'col' ? sheet.cols.sizeOf(index) : sheet.rows.sizeOf(index);
    dragRef.current = { kind: 'resize', axis, index, startPos: axis === 'col' ? e.clientX : e.clientY, startSize, size: startSize };
    setResizeGhost(startSize);
  };

  /** A press on a header of selected whole columns or rows picks them up to move them. False when it is not on one. */
  const pickUpHeaders = (hit: Hit): boolean => {
    const axis = onSelectedHeader(hit);
    if (!axis) return false;
    const p = primaryRange(controller.selection);
    const [from, last] = axis === 'col' ? [p.c1, p.c2] : [p.r1, p.r2];
    dragRef.current = { kind: 'moveDims', axis, from, count: last - from + 1, to: null, down: axis === 'col' ? hit.col : hit.row, moved: false };
    return true;
  };

  const startSelection = (hit: Hit, e: React.PointerEvent) => {
    const sel = controller.selection;
    if (hit.resize) {
      startResize(hit.resize, e);
      return;
    }
    if (!e.shiftKey && pickUpHeaders(hit)) return;
    switch (hit.area) {
      case 'corner':
        controller.select({ ranges: [{ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: MAX_COLS - 1 }], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
        return;
      case 'colHeader': {
        const from = e.shiftKey ? sel.anchor.col : hit.col;
        controller.select({ ranges: [wholeColumns(from, hit.col)], active: { row: 0, col: from }, anchor: { row: 0, col: from } });
        dragRef.current = { kind: 'columns', from };
        return;
      }
      case 'rowHeader': {
        const from = e.shiftKey ? sel.anchor.row : hit.row;
        controller.select({ ranges: [wholeRows(from, hit.row)], active: { row: from, col: 0 }, anchor: { row: from, col: 0 } });
        dragRef.current = { kind: 'rows', from };
        return;
      }
      default:
        selectCell(hit, e);
    }
  };

  const selectCell = (hit: Hit, e: React.PointerEvent) => {
    const sel = controller.selection;
    const merge = sheet.mergeAt(hit.row, hit.col);
    const cell = merge ? { row: merge.r1, col: merge.c1 } : { row: hit.row, col: hit.col };
    if (e.shiftKey) {
      controller.select(extendTo(sel, cell));
      dragRef.current = { kind: 'select', anchor: sel.anchor, additive: false };
      return;
    }
    const additive = e.ctrlKey || e.metaKey;
    if (additive) {
      controller.select({ ranges: [...sel.ranges, rangeFrom(cell, cell)], active: cell, anchor: cell });
    } else {
      controller.select(cellSelection(cell.row, cell.col));
    }
    dragRef.current = { kind: 'select', anchor: cell, additive };
  };

  const trackHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (remote.length === 0) {
      if (hoverCell) setHoverCell(null);
      return;
    }
    const { hit } = pointAt(e);
    const cell = hit.area === 'cell' ? { row: hit.row, col: hit.col } : null;
    setHoverCell((h) => (h?.row === cell?.row && h?.col === cell?.col ? h : cell));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      updateCursor(e);
      trackHover(e);
      return;
    }
    if (drag.kind === 'chart') {
      drag.preview = draggedChart(sheet, drag.chart, drag.handle, e.clientX - drag.startX, e.clientY - drag.startY);
      setChartPreview(drag.preview);
      return;
    }
    if (drag.kind === 'resize') {
      const delta = (drag.axis === 'col' ? e.clientX : e.clientY) - drag.startPos;
      drag.size = Math.max(drag.axis === 'col' ? 20 : 12, drag.startSize + delta);
      setResizeGhost(drag.size);
      return;
    }
    pointerRef.current = { clientX: e.clientX, clientY: e.clientY, mod: e.ctrlKey || e.metaKey };
    dragTo(drag, dragPointAt(e));
    if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(() => autoScrollRef.current());
  };

  const dragTo = (drag: Exclude<Drag, { kind: 'resize' | 'chart' }>, { hit, x, y }: { hit: Hit; x: number; y: number }) => {
    const sel = controller.selection;
    switch (drag.kind) {
      case 'fill':
      case 'move':
      case 'moveDims':
        dragBlock(drag, { hit, x, y });
        return;
      case 'select': {
        const range = expandForMerges(rangeFrom(drag.anchor, hit));
        const ranges = drag.additive ? [...sel.ranges.slice(0, -1), range] : [range];
        controller.select({ ranges, active: drag.anchor, anchor: drag.anchor });
        return;
      }
      case 'columns':
        controller.select({ ...sel, ranges: [wholeColumns(drag.from, hit.col)] });
        return;
      case 'rows':
        controller.select({ ...sel, ranges: [wholeRows(drag.from, hit.row)] });
        return;
      case 'point': {
        const edit = controller.editing;
        if (!edit) return;
        const ref = referenceText(rangeFrom(drag.anchor, hit), sheet.name, sheet.name);
        controller.updateEdit(edit.text.slice(0, drag.start) + ref + edit.text.slice(drag.end));
        drag.end = drag.start + ref.length;
        placeCaret(drag.end);
      }
    }
  };

  /** A fill, a moved block or moved headers following the pointer: where they would land, previewed. */
  const dragBlock = (drag: Extract<Drag, { kind: 'fill' | 'move' | 'moveDims' }>, { hit, x, y }: { hit: Hit; x: number; y: number }) => {
    const mod = pointerRef.current?.mod ?? false;
    if (drag.kind === 'fill') {
      drag.target = fillTarget(drag.source, hit.row, hit.col);
      drag.toggle = mod;
      setDragPreview({ range: drag.target, hint: controller.fillHint(drag.target, drag.toggle), dim: null });
      return;
    }
    if (drag.kind === 'move') {
      const s = drag.source;
      const top = clamp(hit.row - drag.grab.row, 0, sheet.rowCount - 1 - (s.r2 - s.r1));
      const left = clamp(hit.col - drag.grab.col, 0, sheet.colCount - 1 - (s.c2 - s.c1));
      drag.copy = mod;
      if (!drag.at && top === s.r1 && left === s.c1) return;
      drag.at = { row: top, col: left };
      setDragPreview({ range: { r1: top, c1: left, r2: top + s.r2 - s.r1, c2: left + s.c2 - s.c1 }, hint: null, dim: null });
      return;
    }
    const index = drag.axis === 'col' ? hit.col : hit.row;
    const live = dragLayout();
    const seg = (drag.axis === 'col' ? live.cols : live.rows).find((s) => s.index === index);
    const pos = drag.axis === 'col' ? x : y;
    const at = seg && pos > seg.start + seg.size / 2 ? index + 1 : index;
    if (index !== drag.down) drag.moved = true;
    drag.to = at >= drag.from && at <= drag.from + drag.count ? null : at;
    setDragPreview(drag.to === null ? null : { range: null, hint: null, dim: { axis: drag.axis, at: drag.to } });
  };

  const expandForMerges = (r: ReturnType<typeof rangeFrom>) => {
    let out = r;
    for (const m of sheet.merges) {
      if (m.r1 <= out.r2 && m.r2 >= out.r1 && m.c1 <= out.c2 && m.c2 >= out.c1) {
        out = { r1: Math.min(out.r1, m.r1), c1: Math.min(out.c1, m.c1), r2: Math.max(out.r2, m.r2), c2: Math.max(out.c2, m.c2) };
      }
    }
    return out;
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    pointerRef.current = null;
    stopAutoScroll();
    if (drag?.kind === 'fill' || drag?.kind === 'move' || drag?.kind === 'moveDims') {
      setDragPreview(null);
      dropDrag(drag);
      return;
    }
    if (drag?.kind === 'chart') {
      setChartPreview(null);
      // The chart as it is now (a co-editor may have changed it meanwhile), in its new place.
      const current = sheet.charts.find((c) => c.id === drag.chart.id);
      if (current && drag.preview && !samePlace(drag.preview, drag.chart)) {
        saveChart(controller, { ...current, anchor: drag.preview.anchor, width: drag.preview.width, height: drag.preview.height });
      }
      return;
    }
    if (drag?.kind === 'resize') {
      setResizeGhost(null);
      if (drag.size !== drag.startSize) {
        const indices = controller.selectedIndices(drag.axis).includes(drag.index) && isWholeAxisSelected(drag.axis) ? controller.selectedIndices(drag.axis) : [drag.index];
        controller.resize(drag.axis, indices, Math.round(drag.size));
      }
    }
  };

  /** Lets go of a fill, a moved block or moved headers. A press that never moved selects what it was on. */
  const dropDrag = (drag: Extract<Drag, { kind: 'fill' | 'move' | 'moveDims' }>) => {
    switch (drag.kind) {
      case 'fill':
        controller.fill(drag.target, drag.toggle);
        return;
      case 'move': {
        if (drag.at) {
          moveCells(controller, drag.source, drag.at.row, drag.at.col, drag.copy);
          return;
        }
        const merge = sheet.mergeAt(drag.down.row, drag.down.col);
        controller.select(cellSelection(merge?.r1 ?? drag.down.row, merge?.c1 ?? drag.down.col));
        return;
      }
      case 'moveDims':
        if (drag.to !== null) controller.moveDimsTo(drag.axis, drag.from, drag.count, drag.to);
        else if (!drag.moved) {
          const at = drag.down;
          const pos = drag.axis === 'col' ? { row: 0, col: at } : { row: at, col: 0 };
          controller.select({ ranges: [drag.axis === 'col' ? wholeColumns(at, at) : wholeRows(at, at)], active: pos, anchor: pos });
        }
    }
  };

  const isWholeAxisSelected = (axis: 'row' | 'col') =>
    controller.selection.ranges.every((r) => (axis === 'col' ? isWholeColumns(r) : isWholeRows(r)));

  const updateCursor = (e: React.PointerEvent<HTMLDivElement>) => {
    const { hit, x, y } = pointAt(e);
    const onChart = hit.area === 'cell' ? chartAt(layout, sheet, x, y, controller.selectedChart) : null;
    let cursor = 'cell';
    if (onChart) cursor = chartCursor(onChart.handle, controller.readOnly);
    else if (hit.resize) cursor = hit.resize.axis === 'col' ? 'col-resize' : 'row-resize';
    else if (hit.area === 'cell' && onFillHandle(x, y)) cursor = 'crosshair';
    else if (hit.area === 'cell' && onSelectionEdge(x, y)) cursor = 'grab';
    else if (onSelectedHeader(hit)) cursor = 'grab';
    else if (hit.area !== 'cell') cursor = 'default';
    e.currentTarget.style.cursor = cursor;
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { hit, x, y } = pointAt(e);
    const onChart = hit.area === 'cell' ? chartAt(layout, sheet, x, y, controller.selectedChart) : null;
    if (onChart) {
      if (!controller.readOnly) controller.openPanel('chart');
      return;
    }
    if (hit.area === 'cell' && onFillHandle(x, y)) {
      controller.fillToAdjacent();
      return;
    }
    if (hit.resize) {
      // Fits the column or row to its contents; every selected one when it is part of the selection.
      const { axis, index } = hit.resize;
      const selected = controller.selectedIndices(axis);
      fitToData(controller, axis, isWholeAxisSelected(axis) && selected.includes(index) ? selected : [index], measureText);
      return;
    }
    if (hit.area === 'cell') controller.beginEdit();
  };

  const onContextMenuOpen = (e: React.MouseEvent<HTMLDivElement>) => {
    const { hit, x, y } = pointAt(e);
    const onChart = hit.area === 'cell' ? chartAt(layout, sheet, x, y, controller.selectedChart) : null;
    if (onChart) {
      if (controller.commitEdit()) controller.selectChart(onChart.chart.id);
      return;
    }
    if (hit.area === 'cell' && !selectionContains(controller.selection, hit.row, hit.col)) {
      if (controller.commitEdit()) controller.select(cellSelection(hit.row, hit.col));
    }
  };

  // -------------------------------------------------------------------------
  // Keyboard, typing, clipboard (all on the textarea)
  // -------------------------------------------------------------------------

  const suggestions = editing && editing.origin === 'cell' ? currentSuggestions(editing.text, caret) : [];

  const placeCaret = (pos: number) => {
    requestAnimationFrame(() => {
      const el = activeInput();
      if (!el) return;
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const acceptSuggestion = (name: string) => {
    const edit = controller.editing;
    if (!edit) return;
    const at = functionPrefixAt(edit.text, caret);
    if (!at) return;
    const text = `${edit.text.slice(0, at.start)}${name}(${edit.text.slice(caret)}`;
    controller.updateEdit(text);
    placeCaret(at.start + name.length + 1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    // The browser pastes on its own (the paste event below); remember it was Ctrl+Shift+V.
    pasteValues.current = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v';
    if (controller.selectedChart && !controller.editing && handleChartKey(e)) {
      e.preventDefault();
      return;
    }
    if (suggestions.length && handleSuggestionKey(e)) return;
    const handled = controller.editing ? handleEditKey(controller, e) : handleGridKey(controller, e, pageRows());
    if (handled) e.preventDefault();
  };

  /**
   * Keys while a chart is picked: Delete removes it, Enter opens its editor,
   * Escape puts it down. Typing does not start a cell edit; other keys (arrows)
   * go back to the cells.
   */
  const handleChartKey = (e: React.KeyboardEvent): boolean => {
    const id = controller.selectedChart!;
    if (e.key === 'Escape') controller.selectChart(null);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!controller.readOnly) removeChart(controller, id);
    } else if (e.key === 'Enter') {
      if (!controller.readOnly) controller.openPanel('chart');
    } else return e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    return true;
  };

  const handleSuggestionKey = (e: React.KeyboardEvent): boolean => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSuggestionIndex((i) => (i + step + suggestions.length) % suggestions.length);
      e.preventDefault();
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      acceptSuggestion(suggestions[Math.min(suggestionIndex, suggestions.length - 1)]!);
      e.preventDefault();
      return true;
    }
    return false;
  };

  const pageRows = () => Math.max(1, Math.floor(viewH / sheet.rows.defaultSize) - 1);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setCaret(e.target.selectionStart ?? text.length);
    setSuggestionIndex(0);
    if (controller.editing) controller.updateEdit(text, 'cell');
    else controller.beginEdit({ text });
  };

  const onCopy = (e: React.ClipboardEvent<HTMLTextAreaElement>, cut = false) => {
    if (controller.editing) return;
    // A read-only sheet cannot give its cells away: cutting copies.
    const payload = copySelection(controller, cut && !controller.readOnly);
    e.clipboardData.setData('text/plain', payload.text);
    e.clipboardData.setData('text/html', payload.html);
    e.preventDefault();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (controller.editing) return;
    const valuesOnly = pasteValues.current;
    pasteValues.current = false;
    pasteInto(controller, e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html') || null, valuesOnly);
    e.preventDefault();
  };

  // -------------------------------------------------------------------------
  // Editor placement
  // -------------------------------------------------------------------------

  const active = editing ?? controller.selection.active;
  const activeMerge = sheet.mergeAt(active.row, active.col);
  const editRect = rangeRect(layout, sheet, activeMerge ?? { r1: active.row, c1: active.col, r2: active.row, c2: active.col });
  const editStyle = controller.engine.workbook.style(sheet, active.row, active.col);
  const editorVisible = !!editing;
  const addRowsTop = canAddRows ? rowTop(layout, sheet, sheet.rowCount) : size.height;

  // The chip of the connected table the active cell is in, on the table's top edge
  // (over the column headers when the table starts at the top).
  const activeTable = editing ? undefined : controller.dataTableAt(controller.selection.active.row, controller.selection.active.col);
  const chipPlace = (() => {
    if (!activeTable) return null;
    const { r1, c1, r2 } = activeTable.range;
    const top = rowTop(layout, sheet, r1) - TABLE_CHIP_HEIGHT;
    if (rowTop(layout, sheet, r2) + sheet.rows.sizeOf(r2) <= COL_HEADER_HEIGHT || top >= size.height) return null;
    return { top: Math.max(0, top), left: Math.max(headerW + 2, colLeft(layout, sheet, c1)), height: TABLE_CHIP_HEIGHT };
  })();

  const addRows = (e: React.FormEvent) => {
    e.preventDefault();
    const count = Number.parseInt(addRowsCount, 10);
    if (Number.isNaN(count) || count <= 0) {
      setAddRowsCount(ADD_ROWS_DEFAULT);
      return;
    }
    if (!controller.commitEdit()) return;
    controller.addRows(count);
    editorRef.current?.focus({ preventScroll: true });
  };

  /** The add-rows bar sits over the canvas, not in the scroller: wheel turns over it still scroll the grid. */
  const scrollBy = (e: React.WheelEvent) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop += e.deltaY;
    el.scrollLeft += e.deltaX;
  };

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden select-none" data-testid="sheet-grid">
      <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0" aria-hidden />
      <GridContextMenu controller={controller} onCreatePivot={onCreatePivot}>
        <div
          ref={scrollerRef}
          className="absolute inset-0 overflow-auto"
          style={{ cursor: 'cell' }}
          onScroll={onScroll}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoverCell(null)}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenuOpen}
          role="grid"
          aria-rowcount={sheet.rowCount}
          aria-colcount={sheet.colCount}
          aria-label={sheet.name}
        >
          <div
            style={{
              width: headerW + frozenW + physicalScrollSize(content.width),
              height: COL_HEADER_HEIGHT + frozenH + physicalScrollSize(content.height),
            }}
          />
        </div>
      </GridContextMenu>
      {activeTable && chipPlace && (
        <TableChip
          label={tableLabels?.[activeTable.id] ?? t.weldsheets.dataSources.table}
          style={chipPlace}
          readOnly={controller.readOnly}
          filtered={controller.tableFiltered(activeTable.id)}
          onPick={() => controller.selectDataTable(activeTable.id)}
          onAction={(action) => controller.requestTableAction(activeTable.id, action)}
          onToggleFilter={() => controller.toggleTableFilter(activeTable.id)}
          onOpenChange={(open) => {
            chipMenuOpen.current = open;
          }}
          onClosed={() => editorRef.current?.focus({ preventScroll: true })}
        />
      )}
      {addRowsTop < size.height && (
        <form
          onSubmit={addRows}
          onWheel={scrollBy}
          className="absolute z-10 flex items-center gap-2 text-sm text-muted-foreground"
          style={{ top: addRowsTop, left: headerW + 12, height: ADD_ROWS_HEIGHT }}
          data-testid="add-rows"
        >
          <Button type="submit" variant="outline" size="sm" className="h-7">
            {t.weldsheets.editor.addRows}
          </Button>
          <Input
            type="number"
            min={1}
            max={MAX_ROWS - sheet.rowCount}
            value={addRowsCount}
            onChange={(e) => setAddRowsCount(e.target.value)}
            aria-label={t.weldsheets.editor.addRowsCount}
            className="h-7 w-24"
          />
          <span>{t.weldsheets.editor.addRowsSuffix}</span>
        </form>
      )}
      <textarea
        ref={editorRef}
        rows={editing ? editing.text.split('\n').length : 1}
        value={editing ? editing.text : ''}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onCopy={(e) => onCopy(e)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        spellCheck={false}
        autoComplete="off"
        aria-label={controller.inputText(active.row, active.col)}
        className="absolute z-10 resize-none overflow-hidden whitespace-pre-wrap break-words border-2 border-[#1a73e8] bg-background px-[3px] text-foreground outline-none"
        style={
          editorVisible
            ? {
                left: editRect.x - 1,
                top: editRect.y - 1,
                minWidth: editRect.w + 2,
                width: Math.max(editRect.w + 2, Math.min(600, measureEditor(editing.text, editStyle) + 16)),
                minHeight: editRect.h + 2,
                height: 'auto',
                font: fontFor(editStyle),
                lineHeight: `${editRect.h - 4}px`,
                color: editStyle?.color,
                backgroundColor: editStyle?.fill,
              }
            : { left: editRect.x, top: editRect.y, width: 1, height: 1, opacity: 0, padding: 0, border: 0 }
        }
      />
      {cellMenu?.kind === 'filter' && sheet.filter && (
        <FilterMenu controller={controller} col={cellMenu.col} rect={cellRect(cellMenu.row, cellMenu.col)} onClose={() => setCellMenu(null)} />
      )}
      {cellMenu?.kind === 'list' && (
        <ListMenu controller={controller} row={cellMenu.row} col={cellMenu.col} rect={cellRect(cellMenu.row, cellMenu.col)} onClose={() => setCellMenu(null)} />
      )}
      {suggestions.length > 0 && (
        <ul
          className="absolute z-20 min-w-[180px] rounded-md border bg-popover py-1 text-sm text-popover-foreground shadow-md"
          style={{ left: editRect.x, top: editRect.y + editRect.h + 2 }}
          role="listbox"
        >
          {suggestions.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === suggestionIndex}
              className={`cursor-pointer px-3 py-1 font-mono ${i === suggestionIndex ? 'bg-accent' : ''}`}
              onPointerDown={(e) => {
                e.preventDefault();
                acceptSuggestion(name);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function currentSuggestions(text: string, caret: number): string[] {
  if (!isFormulaText(text)) return [];
  const at = functionPrefixAt(text, caret);
  if (!at) return [];
  const list = suggestFunctions(at.prefix);
  return list.length === 1 && list[0] === at.prefix.toUpperCase() ? [] : list;
}

function measureEditor(text: string, style: Parameters<typeof fontFor>[0]): number {
  return Math.max(...text.split('\n').map((line) => measureText(line, style)));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Pixels a frame to scroll a drag held at `p`, before `lo` (back) or within a few pixels of `hi` (on): faster further out. */
function edgeSpeed(p: number, lo: number, hi: number): number {
  if (p < lo) return -Math.min(60, Math.ceil((lo - p) / 3) + 2);
  if (p > hi - 4) return Math.min(60, Math.ceil((p - hi + 4) / 3) + 2);
  return 0;
}

function chartCursor(handle: ChartHandle | undefined, readOnly: boolean): string {
  if (readOnly) return 'default';
  return handle ? HANDLE_CURSOR[handle] : 'move';
}

function drawResizeGhost(ctx: CanvasRenderingContext2D, layout: GridLayout, size: number, drag: Drag | null, theme: GridTheme): void {
  if (!drag || drag.kind !== 'resize') return;
  const segments = drag.axis === 'col' ? layout.cols : layout.rows;
  const seg = segments.find((s) => s.index === drag.index);
  if (!seg) return;
  ctx.fillStyle = theme.selectionBorder;
  if (drag.axis === 'col') ctx.fillRect(seg.start + size - 1, 0, 2, layout.height);
  else ctx.fillRect(0, seg.start + size - 1, layout.width, 2);
}
