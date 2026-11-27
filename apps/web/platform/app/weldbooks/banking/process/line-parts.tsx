/**
 * Small parts of the right-hand side of the processing view: the line header,
 * the success line with Undo, the "Or" actions and the hint row of shortcuts.
 */

import type { ComponentType } from 'react';
import { ArrowLeftRight, CheckCircle2, Link2, Receipt, Tag, Undo2, User, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Kbd } from '@weldsuite/ui/components/kbd';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { directionOf } from './process-model';

export function LineHeader({
  line,
  accountName,
  amountLabel,
  dateLabel,
}: Readonly<{ line: BankLine; accountName: string | null; amountLabel: string; dateLabel: string }>) {
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing.header;
  const inflow = directionOf(line) === 'in';
  return (
    <section className="space-y-3 rounded-xl border p-5" data-testid="line-header">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] text-muted-foreground">
            {tp.lineOf.replace('{date}', dateLabel).replace('{account}', accountName ?? '')}
          </span>
          <h2 className="text-xl font-semibold leading-7">
            {line.counterpartyName || line.description || t.accounting.statusLabels.counterpartyUnknown}
          </h2>
          {line.counterpartyIban ? (
            <span className="font-mono text-[13px] text-muted-foreground">{line.counterpartyIban}</span>
          ) : null}
        </div>
        <span
          className={cn(
            'text-[28px] font-semibold leading-9 tabular-nums',
            inflow && 'text-emerald-700 dark:text-emerald-400',
          )}
          data-testid="line-amount"
        >
          {inflow ? '+' : ''}
          {amountLabel}
        </span>
      </div>
      {line.description ? (
        <p
          className="whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2.5 font-mono text-[13px] [overflow-wrap:anywhere]"
          aria-label={tp.description}
        >
          {line.description}
        </p>
      ) : null}
    </section>
  );
}

/** The success line after an action, with its Undo. Announced politely to screen readers. */
export function ResultBanner({
  text,
  undoPending,
  errorMessage,
  canUndo,
  onUndo,
}: Readonly<{ text: string; undoPending: boolean; errorMessage: string | null; canUndo: boolean; onUndo: () => void }>) {
  const { t } = useI18n();
  const tr = t.weldbooksConnected.processing.result;
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-300/60 bg-emerald-50/60 px-5 py-3.5 dark:border-emerald-900 dark:bg-emerald-950/30"
      role="status"
      data-testid="result-banner"
    >
      <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
      <span className="min-w-[12rem] flex-1 text-sm text-emerald-950 dark:text-emerald-100">{text}</span>
      {canUndo ? (
        <Button type="button" variant="outline" size="sm" onClick={onUndo} disabled={undoPending} aria-keyshortcuts="U" data-testid="undo-button">
          {undoPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Undo2 className="h-4 w-4" />}
          {tr.undo}
          <Kbd className="ml-1">U</Kbd>
        </Button>
      ) : null}
      {errorMessage ? (
        <p className="w-full text-sm text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

export type ActionId = 'several' | 'category' | 'receipt' | 'transfer' | 'private' | 'ignore';

const ACTION_ICONS: Record<ActionId, ComponentType<{ className?: string }>> = {
  several: Link2,
  category: Tag,
  receipt: Receipt,
  transfer: ArrowLeftRight,
  private: User,
  ignore: XCircle,
};

const ACTION_KEYS: Partial<Record<ActionId, string>> = {
  category: 'C',
  receipt: 'R',
  transfer: 'T',
  private: 'P',
  ignore: 'I',
};

const ACTION_ORDER: ActionId[] = ['several', 'category', 'receipt', 'transfer', 'private', 'ignore'];

/** The "Or" actions, each with its shortcut key. */
export function ActionGrid({
  disabled,
  active,
  onRun,
}: Readonly<{ disabled: boolean; active: ActionId | null; onRun: (action: ActionId) => void }>) {
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing;
  return (
    <section className="flex flex-col gap-2.5" aria-label={tp.or}>
      <span className="text-[13px] font-medium text-muted-foreground">{tp.or}</span>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-2">
        {ACTION_ORDER.map((action) => {
          const Icon = ACTION_ICONS[action];
          const key = ACTION_KEYS[action];
          return (
            <Button
              key={action}
              type="button"
              variant="outline"
              disabled={disabled}
              aria-pressed={active === action}
              aria-keyshortcuts={key}
              onClick={() => onRun(action)}
              className="h-11 justify-start gap-2.5 px-3 font-normal"
              data-testid={`action-${action}`}
            >
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{tp.actions[action]}</span>
              {key ? <Kbd>{key}</Kbd> : null}
            </Button>
          );
        })}
      </div>
    </section>
  );
}

/** A quiet row of the shortcuts that matter most. */
export function HintRow() {
  const { t } = useI18n();
  const th = t.weldbooksConnected.processing.hints;
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>
        <Kbd>J</Kbd> <Kbd>K</Kbd> {th.move}
      </span>
      <span>
        <Kbd>⏎</Kbd> {th.accept}
      </span>
      <span>
        <Kbd>U</Kbd> {th.undo}
      </span>
      <span>
        <Kbd>?</Kbd> {th.help}
      </span>
    </p>
  );
}
