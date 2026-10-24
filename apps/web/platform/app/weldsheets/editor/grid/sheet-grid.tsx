import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { copySelection, pasteInto } from '../model/clipboard';
import { acceptsReference, functionPrefixAt, isFormulaText, referenceText, refsInEdit, suggestFunctions } from '../model/formula-edit';
import { handleEditKey, handleGridKey } from '../model/keyboard';
import { MAX_COLS, MAX_ROWS } from '@weldsuite/sheets-engine';
import {
  cellSelection,
  extendTo,
  isWholeColumns,
  isWholeRows,
  rangeFrom,
  selectionContains,
  wholeColumns,
  wholeRows,
  type CellPos,
} from '../model/selection';
import type { SheetController } from '../model/sheet-controller';
import { GridContextMenu } from './grid-context-menu';
import {
  computeLayout,
  hitTest,
  physicalScrollSize,
  rangeRect,
  rowHeaderWidth,
  scrollContentSize,
  scrollIntoView,
  toLogicalScroll,
  toPhysicalScroll,
  COL_HEADER_HEIGHT,
  type GridLayout,
  type Hit,
} from './geometry';
import { fontFor, renderGrid, type RefHighlight } from './renderer';
import { readGridTheme, REFERENCE_COLORS, type GridTheme } from './theme';

type Drag =
  | { kind: 'select'; anchor: CellPos; additive: boolean }
  | { kind: 'columns'; from: number }
  | { kind: 'rows'; from: number }
  | { kind: 'resize'; axis: 'row' | 'col'; index: number; startPos: number; startSize: number; size: number }
  | { kind: 'point'; anchor: CellPos; start: number; end: number };

interface Props {
  controller: SheetController;
  /** The formula bar's input: point mode inserts references there when it is being typed in. */
  barInputRef?: RefObject<HTMLTextAreaElement | null>;
}

/**
 * The spreadsheet grid: a canvas under a transparent native scroller (which
 * supplies scrollbars and wheel/touch scrolling), and one textarea that is
 * both the keyboard sink and the in-cell editor.
 */
export function SheetGrid({ controller, barInputRef }: Props) {
  const version = useSyncExternalStore(controller.subscribe, controller.getVersion);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [resizeGhost, setResizeGhost] = useState<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const themeRef = useRef<GridTheme | null>(null);
  const layoutRef = useRef<GridLayout | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const lastActive = useRef<string>('');

  const sheet = controller.sheet;
  const editing = controller.editing;
  const content = scrollContentSize(sheet);
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

  // The editor follows the active cell and keeps focus unless the formula bar has it.
  useEffect(() => {
    if (editing?.origin === 'bar') return;
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

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { hit, x, y } = pointAt(e);
    if (hit.area === 'cell' && x > layout.width - 16 && y > layout.height - 16) return; // scrollbar corner
    const input = activeInput();
    const caretPos = input?.selectionStart ?? 0;
    const pointing = hit.area === 'cell' && !!editing && acceptsReference(editing.text, caretPos);
    if (pointing) {
      startPointMode(hit, caretPos);
    } else {
      controller.commitEdit();
      startSelection(hit, e);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    (pointing ? input : editorRef.current)?.focus({ preventScroll: true });
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

  const startSelection = (hit: Hit, e: React.PointerEvent) => {
    const sel = controller.selection;
    if (hit.resize) {
      const axis = hit.resize.axis;
      const startSize = axis === 'col' ? sheet.cols.sizeOf(hit.resize.index) : sheet.rows.sizeOf(hit.resize.index);
      dragRef.current = {
        kind: 'resize',
        axis,
        index: hit.resize.index,
        startPos: axis === 'col' ? e.clientX : e.clientY,
        startSize,
        size: startSize,
      };
      setResizeGhost(startSize);
      return;
    }
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

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      updateCursor(e);
      return;
    }
    if (drag.kind === 'resize') {
      const delta = (drag.axis === 'col' ? e.clientX : e.clientY) - drag.startPos;
      drag.size = Math.max(drag.axis === 'col' ? 20 : 12, drag.startSize + delta);
      setResizeGhost(drag.size);
      return;
    }
    const { hit } = pointAt(e);
    dragTo(drag, hit);
  };

  const dragTo = (drag: Exclude<Drag, { kind: 'resize' }>, hit: Hit) => {
    const sel = controller.selection;
    switch (drag.kind) {
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
    if (drag?.kind === 'resize') {
      setResizeGhost(null);
      if (drag.size !== drag.startSize) {
        const indices = controller.selectedIndices(drag.axis).includes(drag.index) && isWholeAxisSelected(drag.axis) ? controller.selectedIndices(drag.axis) : [drag.index];
        controller.resize(drag.axis, indices, Math.round(drag.size));
      }
    }
  };

  const isWholeAxisSelected = (axis: 'row' | 'col') =>
    controller.selection.ranges.every((r) => (axis === 'col' ? isWholeColumns(r) : isWholeRows(r)));

  const updateCursor = (e: React.PointerEvent<HTMLDivElement>) => {
    const { hit } = pointAt(e);
    let cursor = 'cell';
    if (hit.resize) cursor = hit.resize.axis === 'col' ? 'col-resize' : 'row-resize';
    else if (hit.area !== 'cell') cursor = 'default';
    e.currentTarget.style.cursor = cursor;
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { hit } = pointAt(e);
    if (hit.resize) {
      controller.resize(hit.resize.axis, [hit.resize.index], null);
      return;
    }
    if (hit.area === 'cell') controller.beginEdit();
  };

  const onContextMenuOpen = (e: React.MouseEvent<HTMLDivElement>) => {
    const { hit } = pointAt(e);
    if (hit.area === 'cell' && !selectionContains(controller.selection, hit.row, hit.col)) {
      controller.commitEdit();
      controller.select(cellSelection(hit.row, hit.col));
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
    if (suggestions.length && handleSuggestionKey(e)) return;
    const handled = controller.editing ? handleEditKey(controller, e) : handleGridKey(controller, e, pageRows());
    if (handled) e.preventDefault();
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
    pasteInto(controller, e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html') || null);
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

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden select-none" data-testid="sheet-grid">
      <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0" aria-hidden />
      <GridContextMenu controller={controller}>
        <div
          ref={scrollerRef}
          className="absolute inset-0 overflow-auto"
          style={{ cursor: 'cell' }}
          onScroll={onScroll}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
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
      <textarea
        ref={editorRef}
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

let measureCanvas: HTMLCanvasElement | null = null;

function measureEditor(text: string, style: Parameters<typeof fontFor>[0]): number {
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = fontFor(style);
  return Math.max(...text.split('\n').map((line) => ctx.measureText(line).width));
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
