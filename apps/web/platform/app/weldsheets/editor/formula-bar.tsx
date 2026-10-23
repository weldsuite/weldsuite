import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { formatRange, parseRange, type Range } from '@weldsuite/sheets-engine';
import { useI18n } from '@/lib/i18n/provider';
import { clampToGrid, primaryRange } from './model/selection';
import type { SheetController } from './model/sheet-controller';

interface Props {
  controller: SheetController;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export function FormulaBar({ controller, inputRef }: Props) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const { active } = controller.selection;
  const editing = controller.editing;
  const value = editing ? editing.text : controller.inputText(active.row, active.col);

  const onFocus = () => {
    if (!controller.editing) controller.beginEdit({ origin: 'bar' });
    else controller.updateEdit(controller.editing.text, 'bar');
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (controller.editing) controller.updateEdit(e.target.value, 'bar');
    else controller.beginEdit({ text: e.target.value, origin: 'bar' });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      controller.cancelEdit();
      e.currentTarget.blur();
      e.preventDefault();
      return;
    }
    if ((e.key === 'Enter' && !e.altKey) || e.key === 'Tab') {
      controller.commitEdit();
      if (e.key === 'Tab') controller.advance(0, e.shiftKey ? -1 : 1);
      else controller.advance(e.shiftKey ? -1 : 1, 0);
      e.currentTarget.blur();
      e.preventDefault();
    }
  };

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b text-sm">
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
        spellCheck={false}
        aria-label={t.weldsheets.editor.formulaBar}
        className="min-w-0 flex-1 resize-none bg-transparent px-2 py-[6px] font-mono text-[13px] leading-5 outline-none"
      />
    </div>
  );
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

