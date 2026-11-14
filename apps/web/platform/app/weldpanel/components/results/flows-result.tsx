/**
 * A flows result as readable step columns: the anchor event, then for each
 * step the most common next (or previous) pages or events with how many people
 * took them, followed by the most common whole paths. No Sankey: columns of
 * bars read well at any width and need no layout engine.
 */

import { ArrowRight } from 'lucide-react';
import type { PanelFlowsResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { formatNumber, formatPercent } from '../../lib/format';

/** Values shown per column before the rest is left out. */
const COLUMN_ROWS = 6;

interface FlowColumn {
  /** 1 for the step next to the anchor. */
  step: number;
  total: number;
  rows: { value: string | null; count: number }[];
}

/** Sums the path counts per value at each step. Exported for tests. */
export function flowColumns(result: PanelFlowsResult): FlowColumn[] {
  return Array.from({ length: result.depth }, (_, step) => {
    const counts = new Map<string | null, number>();
    let total = 0;
    for (const path of result.paths) {
      const value = path.steps[step] ?? null;
      counts.set(value, (counts.get(value) ?? 0) + path.count);
      total += path.count;
    }
    const rows = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, COLUMN_ROWS);
    return { step: step + 1, total, rows };
  });
}

interface FlowsResultViewProps {
  result: PanelFlowsResult;
  compact?: boolean;
}

export function FlowsResultView({ result, compact = false }: Readonly<FlowsResultViewProps>) {
  const { t, language } = useI18n();
  const tf = t.weldpanel.analytics.flows;
  const columns = flowColumns(result);
  // For `before`, steps are nearest-first: show the furthest on the left so time reads left to right.
  const ordered = result.direction === 'before' ? [...columns].reverse() : columns;

  if (result.paths.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{tf.noPaths}</p>;

  const anchorColumn = (
    <div className="grid min-w-44 content-start gap-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.anchorTitle}</p>
      <div className="rounded-md border border-primary/40 bg-primary/10 p-2">
        <p className="truncate text-sm font-medium">{result.anchor}</p>
        <p className="text-xs tabular-nums text-muted-foreground">{tf.anchorCount.replace('{count}', formatNumber(result.anchorCount, language))}</p>
      </div>
    </div>
  );

  return (
    <div className="grid gap-6">
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max items-start gap-3">
          {result.direction === 'after' && anchorColumn}
          {ordered.map((column) => (
            <div key={column.step} className="flex items-start gap-3">
              <ArrowRight className="mt-8 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="grid min-w-44 max-w-56 content-start gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.stepN.replace('{n}', String(column.step))}</p>
                {column.rows.map((row) => (
                  <div key={row.value ?? '__left__'} className="relative overflow-hidden rounded-md border p-2">
                    <div className="absolute inset-y-0 left-0 bg-primary/15" style={{ width: `${column.total > 0 ? (row.count / column.total) * 100 : 0}%` }} aria-hidden />
                    <p className={cn('relative truncate text-sm', row.value === null && 'italic text-muted-foreground')} title={row.value ?? undefined}>
                      {row.value ?? tf.left}
                    </p>
                    <p className="relative text-xs tabular-nums text-muted-foreground">{formatNumber(row.count, language)}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {result.direction === 'before' && (
            <div className="flex items-start gap-3">
              <ArrowRight className="mt-8 size-4 shrink-0 text-muted-foreground" aria-hidden />
              {anchorColumn}
            </div>
          )}
        </div>
      </div>

      {!compact && (
        <section className="grid gap-2" aria-label={tf.pathsTitle}>
          <h3 className="text-sm font-medium">{tf.pathsTitle}</h3>
          <ol className="grid gap-1.5">
            {result.paths.map((path, index) => {
              const share = result.anchorCount > 0 ? path.count / result.anchorCount : 0;
              const steps = path.steps.map((s) => s ?? tf.left);
              const chain = result.direction === 'before' ? [...steps].reverse().concat(result.anchor) : [result.anchor, ...steps];
              return (
                <li key={`${index}:${chain.join('>')}`} className="relative overflow-hidden rounded-md border px-3 py-2">
                  <div className="absolute inset-y-0 left-0 bg-primary/10" style={{ width: `${Math.min(100, share * 100)}%` }} aria-hidden />
                  <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{chain.join(' → ')}</p>
                    <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatNumber(path.count, language)} ·{' '}
                      {tf.pathShare.replace('{percent}', formatPercent(share, language)).replace('{total}', formatNumber(result.anchorCount, language))}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
