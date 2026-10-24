import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Condition } from '@weldsuite/sheets-engine';
import { clampToGrid, primaryRange } from '../model/selection';
import type { SheetController } from '../model/sheet-controller';
import { rangesText } from './conditions';

/** The right-hand panel frame both rule panels use. */
export function RulePanel({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background" aria-label={title}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <h2 className="text-sm font-medium">{title}</h2>
        <button type="button" className="rounded p-1 hover:bg-accent" onClick={onClose} aria-label={closeLabel}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">{children}</div>
    </aside>
  );
}

/** The selection as range text, the default range of a new rule. */
export function selectionText(controller: SheetController): string {
  const sheet = controller.sheet;
  return rangesText([clampToGrid(primaryRange(controller.selection), sheet.rowCount, sheet.colCount)]);
}

/** "Greater than 10" for a rule's condition, in the viewer's words. */
export function conditionSummary(c: Condition, labels: Record<Condition['type'], string>): string {
  switch (c.type) {
    case 'empty':
    case 'notEmpty':
      return labels[c.type];
    case 'between':
    case 'notBetween':
      return `${labels[c.type]} ${c.min} – ${c.max}`;
    case 'formula':
      return `${labels[c.type]} =${c.formula}`;
    default:
      return `${labels[c.type]} ${c.value}`;
  }
}
