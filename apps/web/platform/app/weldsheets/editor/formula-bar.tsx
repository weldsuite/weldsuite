import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
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

export function FormulaBar({ controller, inputRef }: Props) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const { active } = controller.selection;
  const editing = controller.editing;
  const value = editing ? editing.text : controller.inputText(active.row, active.col);
  const [caret, setCaret] = useState(0);

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
    <div className="relative flex h-8 shrink-0 items-stretch border-b text-sm">
      <NameBox controller={controller} label={t.weldsheets.editor.nameBox} />
      <div className="flex w-9 shrink-0 items-center justify-center border-r font-serif italic text-muted-foreground" aria-hidden>
        fx
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
        className="min-w-0 flex-1 resize-none bg-transparent px-2 py-[6px] font-mono text-[13px] leading-5 outline-none"
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
  const lineWidth = Math.max(1, input.clientWidth - 2 * padding);
  let x = 0;
  if (ctx) {
    ctx.font = style.font;
    const line = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
    x = ctx.measureText(line).width % lineWidth;
  }
  const barWidth = input.parentElement?.clientWidth ?? input.offsetLeft + input.clientWidth;
  return Math.max(0, Math.min(input.offsetLeft + padding + x - input.scrollLeft, barWidth - POPUP_WIDTH - 8));
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
    <input
      value={draft ?? current}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          go();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => setDraft(null)}
      aria-label={label}
      className="w-24 shrink-0 border-r bg-transparent px-2 text-[13px] outline-none focus:bg-muted"
    />
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

