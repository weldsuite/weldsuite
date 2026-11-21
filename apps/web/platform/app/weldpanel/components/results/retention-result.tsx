/**
 * A retention result as a cohort grid (one row per cohort, one column per
 * period, shaded by the share that came back) next to the retention curve
 * (the average share per period). A breakdown adds one grid per value and one
 * curve line per value.
 */

import type { PanelRetentionCohort, PanelRetentionResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { useI18n } from '@/lib/i18n/provider';
import { formatDay, formatNumber, formatPercent } from '../../lib/format';
import { ValueLineChart, type ExploreDatum, type ExploreSeries } from './charts';

interface RetentionResultViewProps {
  result: PanelRetentionResult;
  /** Leave the curve out (small tiles). */
  gridOnly?: boolean;
}

/** Cell background: the primary color at a strength that follows the share (0-1). */
function cellStyle(share: number): { backgroundColor: string; color?: string } {
  const strength = Math.round(Math.min(1, Math.max(0, share)) * 85);
  return { backgroundColor: `color-mix(in oklab, var(--primary) ${strength}%, transparent)`, color: share > 0.55 ? 'var(--primary-foreground)' : undefined };
}

function RetentionGrid({ result, cohorts, averageRetention, label }: Readonly<{ result: PanelRetentionResult; cohorts: PanelRetentionCohort[]; averageRetention: number[]; label?: string }>) {
  const { t, language } = useI18n();
  const tr = t.weldpanel.analytics.retention;
  const columns = Array.from({ length: result.periods + 1 }, (_, n) => n);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-sm" aria-label={label}>
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
          {cohorts.map((cohort) => (
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
              const share = averageRetention[n];
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

/** The curve's points: one row per period, one column per line (the whole, or each breakdown value). */
export function retentionCurve(result: PanelRetentionResult, periodLabel: string, averageLabel: string, otherLabel: string): { data: ExploreDatum[]; series: ExploreSeries[] } {
  const lines = result.breakdowns && result.breakdowns.length > 0
    ? result.breakdowns.map((b, i) => ({ key: `b${i}`, label: b.value === 'Other' ? otherLabel : b.value, values: b.averageRetention }))
    : [{ key: 'average', label: averageLabel, values: result.averageRetention }];
  const data: ExploreDatum[] = Array.from({ length: result.periods + 1 }, (_, n) => {
    const row: ExploreDatum = { label: periodLabel.replace('{n}', String(n)) };
    for (const line of lines) row[line.key] = line.values[n] ?? null;
    return row;
  });
  return { data, series: lines.map(({ key, label }) => ({ key, label })) };
}

export function RetentionResultView({ result, gridOnly = false }: Readonly<RetentionResultViewProps>) {
  const { t, language, format } = useI18n();
  const tr = t.weldpanel.analytics.retention;
  const tx = t.weldpanel.explore.retention;
  const other = t.weldpanel.analytics.common.other;
  const breakdowns = result.breakdowns ?? null;
  const curve = retentionCurve(result, tr.periodLabel[result.interval], tx.average, other);

  let grids = <RetentionGrid result={result} cohorts={result.cohorts} averageRetention={result.averageRetention} />;
  if (breakdowns !== null && breakdowns.length === 0) grids = <p className="text-sm text-muted-foreground">{tx.noBreakdownData}</p>;
  else if (breakdowns !== null)
    grids = (
      <div className="grid gap-5">
        {breakdowns.map((b) => {
          const title = format(tx.breakdownValue, { value: b.value === 'Other' ? other : b.value });
          return (
            <section key={b.value} className="grid gap-2" aria-label={title}>
              <h3 className="text-sm font-medium">{title}</h3>
              <RetentionGrid result={result} cohorts={b.cohorts} averageRetention={b.averageRetention} label={title} />
            </section>
          );
        })}
      </div>
    );

  if (gridOnly) return grids;

  return (
    <div className="grid gap-6 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0">{grids}</div>
      <section className="grid content-start gap-2" aria-label={tx.curve}>
        <h3 className="text-sm font-medium">{tx.curve}</h3>
        <ValueLineChart
          data={curve.data}
          series={curve.series}
          locale={language}
          format={(v) => formatPercent(v, language)}
          axisFormat={(v) => formatPercent(v, language, 0)}
          yDomain={[0, 1]}
        />
      </section>
    </div>
  );
}
