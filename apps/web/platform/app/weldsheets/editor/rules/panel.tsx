import type { ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { Condition } from '@weldsuite/sheets-engine';
import { clampToGrid, primaryRange } from '../model/selection';
import type { SheetController } from '../model/sheet-controller';
import { rangesText } from './conditions';

/**
 * The right-hand panel frame every side panel uses: a header, an optional
 * `top` bar that stays put, the body (the only part that scrolls) and an
 * optional `footer` (an editor's Cancel / Done) that stays at the bottom.
 * Panels follow one pattern in the body: a short `PanelIntro`, the main
 * action as a `PanelAction`, then the list or an `EmptyText`.
 */
export function RulePanel({
  title,
  closeLabel,
  onClose,
  top,
  footer,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  top?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside className="flex min-h-0 w-80 shrink-0 flex-col border-l bg-background" aria-label={title}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <h2 className="text-sm font-medium">{title}</h2>
        <button type="button" className="rounded p-1 hover:bg-accent" onClick={onClose} aria-label={closeLabel}>
          <X className="size-4" />
        </button>
      </div>
      {top}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">{children}</div>
      {footer && <div className="flex shrink-0 items-center gap-2 border-t bg-background p-3">{footer}</div>}
    </aside>
  );
}

/** A short muted line saying what the panel is for. */
export function PanelIntro({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/** The panel's main action: a full-width outline button with a + icon. */
export function PanelAction({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="outline" size="sm" className="w-full" onClick={onClick} disabled={disabled}>
      <Plus />
      {children}
    </Button>
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
