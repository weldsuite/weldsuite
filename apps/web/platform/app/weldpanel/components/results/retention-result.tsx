/** A retention result as a cohort grid: one row per cohort, one column per period, shaded by the share that came back. */

import type { PanelRetentionResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { useI18n } from '@/lib/i18n/provider';
import { formatDay, formatNumber, formatPercent } from '../../lib/format';

interface RetentionResultViewProps {
  result: PanelRetentionResult;
}

/** Cell background: the primary color at a strength that follows the share (0-1). */
function cellStyle(share: number): { backgroundColor: string; color?: string } {
  const strength = Math.round(Math.min(1, Math.max(0, share)) * 85);
  return { backgroundColor: `color-mix(in oklab, var(--primary) ${strength}%, transparent)`, color: share > 0.55 ? 'var(--primary-foreground)' : undefined };
}

export function RetentionResultView({ result }: Readonly<RetentionResultViewProps>) {
  const { t, language } = useI18n();
  const tr = t.weldpanel.analytics.retention;
  const columns = Array.from({ length: result.periods + 1 }, (_, n) => n);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th scope="col" className="px-2 py-1 text-left font-medium">
              {tr.cohort}
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              {tr.size}
            </th>
            {columns.map((n) => (
              <th key={n} scope="col" className="min-w-16 px-2 py-1 text-center font-medium">
                {tr.periodLabel[result.interval].replace('{n}', String(n))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.cohorts.map((cohort) => (
            <tr key={cohort.cohort}>
              <th scope="row" className="whitespace-nowrap px-2 py-1 text-left font-normal">
                {formatDay(cohort.cohort, language)}
              </th>
              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{formatNumber(cohort.size, language)}</td>
              {columns.map((n) => {
                const count = cohort.counts[n];
                if (count === undefined) return <td key={n} className="rounded bg-muted/30" />;
                const share = cohort.size > 0 ? count / cohort.size : 0;
                return (
                  <td
                    key={n}
                    className="rounded px-2 py-1 text-center tabular-nums"
                    style={cellStyle(share)}
                    title={tr.cellTitle
                      .replace('{count}', formatNumber(count, language))
                      .replace('{size}', formatNumber(cohort.size, language))
                      .replace('{percent}', formatPercent(share, language))}
                  >
                    {formatPercent(share, language, 0)}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="font-medium">
            <th scope="row" className="px-2 py-1 text-left">
              {tr.average}
            </th>
            <td />
            {columns.map((n) => {
              const share = result.averageRetention[n];
              return (
                <td key={n} className="rounded px-2 py-1 text-center tabular-nums" style={share === undefined ? undefined : cellStyle(share)}>
                  {share === undefined ? '' : formatPercent(share, language, 0)}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
