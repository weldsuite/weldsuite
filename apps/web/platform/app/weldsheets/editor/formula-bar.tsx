import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { formatRange, parseRange, type Range } from '@weldsuite/sheets-engine';
import { useI18n } from '@/lib/i18n/provider';
import { FormulaAssistPopup, useFormulaAssist } from './formula-assist';
import { clampToGrid, primaryRange } from './model/selection';
import type { SheetController } from './model/sheet-controller';

interface Props {
  controller: SheetController;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/** Widest the suggestion list gets: it is kept inside the bar. */
const POPUP_WIDTH = 340;
/** Tallest the bar grows (5 lines of 20px plus padding); past that it scrolls. */
const MAX_BAR_HEIGHT = 112;
/** Browsers that size a textarea to its text themselves; the others are measured below. */
const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

export function FormulaBar({ controller, inputRef }: Props) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const { active } = controller.selection;
  const editing = controller.editing;
  const value = editing ? editing.text : controller.inputText(active.row, active.col);
  const [caret, setCaret] = useState(0);

  // A long formula wraps and the bar grows a line at a time (up to MAX_BAR_HEIGHT), so it can be read whole.
  // `field-sizing: content` does that in CSS; where it is missing, the height is measured.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (FIELD_SIZING || !el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, MAX_BAR_HEIGHT)}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    // A new width changes where the text wraps (the height it sets itself is ignored).
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [inputRef, value]);

  const placeCaret = (pos: number) => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const assist = useFormulaAssist(controller, editing?.origin === 'bar' ? editing.text : null, caret, (text, pos) => {
    controller.updateEdit(text, 'bar');
    placeCaret(pos);
  });
  const anchor = assist.list?.start ?? assist.hint?.start;

  const onFocus = () => {
    if (!controller.editing) controller.beginEdit({ origin: 'bar' });
    else controller.updateEdit(controller.editing.text, 'bar');
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    const pos = e.target.selectionStart ?? text.length;
    setCaret(pos);
    assist.noteTyping(text, pos);
    if (controller.editing) controller.updateEdit(text, 'bar');
    else controller.beginEdit({ text, origin: 'bar' });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (assist.onKeyDown(e)) return;
    if (e.key === 'Escape') {
      controller.cancelEdit();
      e.currentTarget.blur();
      e.preventDefault();
      return;
    }
    if ((e.key === 'Enter' && !e.altKey) || e.key === 'Tab') {
      e.preventDefault();
      commitAndMove(e);
    }
  };

  /** Enter and Tab commit, then move down (up with Shift) or right (left). */
  const commitAndMove = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Refused by a strict validation rule: stay in the bar to correct it.
    if (!controller.commitEdit()) return;
    if (e.key === 'Tab') controller.advance(0, e.shiftKey ? -1 : 1);
    else controller.advance(e.shiftKey ? -1 : 1, 0);
    e.currentTarget.blur();
  };

  return (
    // The name box and fx columns run the bar's full height, their text on its first line.
    <div className="relative flex min-h-8 shrink-0 border-b text-sm">
      <NameBox controller={controller} label={t.weldsheets.editor.nameBox} />
      <div className="flex w-9 shrink-0 justify-center border-r font-serif italic text-muted-foreground" aria-hidden>
        <span className="flex h-8 items-center">fx</span>
      </div>
      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        onFocus={onFocus}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        spellCheck={false}
        autoComplete="off"
        aria-label={t.weldsheets.editor.formulaBar}
        aria-autocomplete="list"
        readOnly={controller.readOnly}
        className="max-h-28 min-h-8 min-w-0 flex-1 self-start resize-none overflow-y-auto bg-transparent px-2 py-1.5 font-mono text-[13px] leading-5 outline-none [field-sizing:content]"
      />
      {anchor !== undefined && editing && (
        <FormulaAssistPopup
          assist={assist}
          controller={controller}
          style={{ top: 'calc(100% + 2px)', left: popupLeft(inputRef.current, editing.text, anchor) }}
        />
      )}
    </div>
  );
}

let measureCanvas: HTMLCanvasElement | null = null;

/** Where in the bar the text at `index` starts, so the list opens under the name being typed (kept inside the bar). */
function popupLeft(input: HTMLTextAreaElement | null, text: string, index: number): number {
  if (!input) return 0;
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  const style = getComputedStyle(input);
  const padding = Number.parseFloat(style.paddingLeft) || 0;
  let x = 0;
  if (ctx) {
    ctx.font = style.font;
    const line = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
    // The bar wraps a long line: roughly where on its wrapped row the name starts.
    const width = input.clientWidth - padding - (Number.parseFloat(style.paddingRight) || 0);
    x = ctx.measureText(line).width;
    if (width > 0) x %= width;
  }
  const barWidth = input.parentElement?.clientWidth ?? input.offsetLeft + input.clientWidth;
  return Math.max(0, Math.min(input.offsetLeft + padding + x, barWidth - POPUP_WIDTH - 8));
}

function NameBox({ controller, label }: { controller: SheetController; label: string }) {
  const sheet = controller.sheet;
  const current = formatRange(primaryRange(controller.selection));
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => setDraft(null), [current]);

  const go = () => {
    const text = (draft ?? '').trim();
    setDraft(null);
    const target = resolveAddress(controller, text);
    if (!target) return;
    controller.setActiveSheet(target.sheetId);
    const r = clampToGrid(target.range, sheet.rowCount, sheet.colCount);
    controller.select({ ranges: [target.range], active: { row: r.r1, col: r.c1 }, anchor: { row: r.r1, col: r.c1 } });
  };

  return (
    <div className="w-24 shrink-0 border-r focus-within:bg-muted">
      <input
        value={draft ?? current}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          // Consumed here: selecting the target hands focus to the grid mid-keystroke, and an
          // Enter that went on would open the cell's editor with a newline and erase it on the next click.
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            go();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => setDraft(null)}
        aria-label={label}
        className="h-8 w-full bg-transparent px-2 text-[13px] outline-none"
      />
    </div>
  );
}

/** "B7", "A1:C9", "Sheet2!D4" or a defined name → where to go. */
function resolveAddress(controller: SheetController, text: string): { sheetId: string; range: Range } | null {
  if (!text) return null;
  const bang = text.lastIndexOf('!');
  const sheetPart = bang >= 0 ? text.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'") : null;
  const rangePart = bang >= 0 ? text.slice(bang + 1) : text;
  const sheet = sheetPart ? controller.engine.workbook.getSheetByName(sheetPart) : controller.sheet;
  if (!sheet) return null;
  const range = parseRange(rangePart);
  if (range) return { sheetId: sheet.id, range };
  const named = controller.engine.definedName(text, controller.activeSheetId);
  if (named === undefined) return null;
  return resolveNamedRange(controller, named);
}

function resolveNamedRange(controller: SheetController, formula: string): { sheetId: string; range: Range } | null {
  const bang = formula.lastIndexOf('!');
  const sheetName = bang >= 0 ? formula.slice(0, bang).replace(/^'|'$/g, '') : null;
  const sheet = sheetName ? controller.engine.workbook.getSheetByName(sheetName) : controller.sheet;
  const range = parseRange(bang >= 0 ? formula.slice(bang + 1) : formula);
  return sheet && range ? { sheetId: sheet.id, range } : null;
}

