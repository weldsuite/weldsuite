/**
 * A top list in the Plausible style: a row per value with a bar behind it
 * sized by visitors, and one or two numbers on the right. A row is a button
 * when `onSelect` is given (click to filter the page).
 */

import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatNumber } from '../lib/format';

export interface BreakdownListRow {
  /** Stable key and the value a filter would use. */
  key: string;
  /** What is shown (a country name, "Direct / none"...). */
  label: string;
  primary: number;
  secondary?: number;
}

interface BreakdownListProps {
  rows: BreakdownListRow[];
  primaryLabel: string;
  secondaryLabel?: string;
  /** Rows currently used as a filter are highlighted. */
  selectedKeys?: readonly string[];
  onSelect?: (key: string) => void;
  /** Accessible name for a row button, with `{value}` replaced. */
  rowLabel?: string;
  emptyText: string;
}

export function BreakdownList({ rows, primaryLabel, secondaryLabel, selectedKeys = [], onSelect, rowLabel, emptyText }: Readonly<BreakdownListProps>) {
  const { language } = useI18n();
  const max = Math.max(1, ...rows.map((r) => r.primary));

  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;

  return (
    <div role="table" aria-label={primaryLabel} className="grid gap-0.5 text-sm">
      <div role="row" className="flex items-center justify-between px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span role="columnheader" />
        <span className="flex gap-4">
          {secondaryLabel && (
            <span role="columnheader" className="w-20 text-right">
              {secondaryLabel}
            </span>
          )}
          <span role="columnheader" className="w-20 text-right">
            {primaryLabel}
          </span>
        </span>
      </div>
      {rows.map((row) => {
        const selected = selectedKeys.includes(row.key);
        const content = (
          <>
            <span className="absolute inset-y-0 left-0 rounded bg-primary/10" style={{ width: `${(row.primary / max) * 100}%` }} aria-hidden />
            <span className="relative min-w-0 flex-1 truncate text-left" title={row.label}>
              {row.label}
            </span>
            <span className="relative flex gap-4 tabular-nums">
              {row.secondary !== undefined && <span className="w-20 text-right text-muted-foreground">{formatNumber(row.secondary, language)}</span>}
              <span className="w-20 text-right font-medium">{formatNumber(row.primary, language)}</span>
            </span>
          </>
        );
        const className = cn('relative flex w-full items-center justify-between gap-3 overflow-hidden rounded px-2 py-1.5', selected && 'ring-1 ring-primary');
        return (
          <div role="row" key={row.key}>
            {onSelect ? (
              <button
                type="button"
                className={cn(className, 'transition-colors hover:bg-accent/50')}
                aria-pressed={selected}
                aria-label={rowLabel?.replace('{value}', row.label)}
                onClick={() => onSelect(row.key)}
              >
                {content}
              </button>
            ) : (
              <div className={className}>{content}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
