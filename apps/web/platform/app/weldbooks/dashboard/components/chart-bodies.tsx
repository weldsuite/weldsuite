/**
 * The bodies of the overview's cards, shared by the built-in cards, the user's
 * own charts and the chart builder's preview:
 *
 * - `MetricChartBody`: a trend's total over the range, its change against the
 *   comparison and the comparison's total, then the chart.
 * - `BreakdownBody`: receivables or payables by age, or cash per account, as of today.
 */

import { useMemo } from 'react';
import type { Dashboard, DashboardAgingBucket } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { BreakdownList, type BreakdownItem } from './breakdown-list';
import { ComparisonLineChart } from './comparison-line-chart';
import { percentChange, rangeSeries, type Compare, type Metric, type TrendMonth } from './dashboard-series';
import { useChartFormat } from './use-chart-format';

const BUCKETS: DashboardAgingBucket[] = ['current', '1-30', '31-60', '61-90', '90+'];
/** Not due in the chart colour, then Stripe's warning-to-danger ramp as invoices age. */
const BUCKET_COLORS: Record<DashboardAgingBucket, string> = {
  current: 'var(--chart-1)',
  '1-30': '#f5b900',
  '31-60': '#ed6704',
  '61-90': '#df1b41',
  '90+': '#a3123a',
};
const ACCOUNT_COLORS = ['var(--chart-1)', 'var(--chart-2)', '#00a2b8', '#8d7ffa', '#ed6704'];

export function MetricChartBody({
  metric,
  months,
  sample,
  size,
  compare,
  shape = 'line',
  color,
  label,
}: Readonly<{
  metric: Metric;
  months: TrendMonth[];
  sample: boolean;
  size: number;
  compare: Compare | null;
  shape?: 'line' | 'area' | 'bar';
  color?: string;
  /** The chart's name in its tooltip; the metric's name by default. */
  label?: string;
}>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const format = useChartFormat();
  const series = useMemo(() => rangeSeries(months, metric, size, compare), [months, metric, size, compare]);
  // A month the API has no figure for draws as zero, like a month with nothing booked: the card
  // always shows a line, never an empty state. The sample trend only draws the lines: the figures
  // stay the workspace's own, "—" while nothing is booked.
  const total = sample ? null : (series.total ?? 0);
  const compareTotal = sample ? null : series.compareTotal;
  const points = useMemo(() => series.points.map((p) => ({ ...p, value: p.value ?? 0 })), [series.points]);

  const titles: Record<Metric, string> = { revenue: tc.revenue, expenses: tc.expenses, profit: tc.netProfit };
  const change = percentChange(sample ? null : series.total, compareTotal);
  const compareText = compare === 'previousYear' ? tc.previousYearValue : tc.previousPeriodValue;

  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className={`text-xl tabular-nums ${(total ?? 0) < 0 ? 'text-destructive' : ''}`}>
          {total === null ? '—' : format.formatMoney(total)}
        </span>
        {change !== null && (
          <span className={`text-sm tabular-nums ${changeTone(metric, change)}`}>{format.percent(change)}</span>
        )}
      </div>
      {compare && (
        <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">
          {compareTotal === null ? tc.noComparison : compareText.replace('{amount}', format.formatMoney(compareTotal))}
        </p>
      )}
      <ComparisonLineChart
        variant="card"
        shape={shape}
        color={color}
        points={points}
        label={label || titles[metric]}
        compareLabel={compare === 'previousYear' ? tc.previousYear : tc.previousPeriod}
        formatTick={format.monthYear}
        className="mt-4 aspect-auto h-[250px] w-full"
      />
    </>
  );
}

/** Up is good for revenue and profit and bad for expenses; no change stays muted. */
function changeTone(metric: Metric, change: number): string {
  if (change === 0) return 'text-muted-foreground';
  const good = metric === 'expenses' ? change < 0 : change > 0;
  return good ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive';
}

export function BreakdownBody({
  source,
  dashboard,
}: Readonly<{ source: 'receivables' | 'payables' | 'cash'; dashboard: Dashboard }>) {
  const { t } = useI18n();
  const aging = useAgingItems(source === 'cash' ? 'receivables' : source, dashboard);
  const cash = useCashItems(dashboard);
  if (source !== 'cash') return <BreakdownList items={aging} />;
  if (cash.length === 0) return <p className="text-sm text-muted-foreground">{t.accounting.dashboard.noBankAccounts}</p>;
  return <BreakdownList items={cash} />;
}

function useAgingItems(side: 'receivables' | 'payables', dashboard: Dashboard): BreakdownItem[] {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const { formatMoney } = useChartFormat();
  const summary = dashboard[side];

  return useMemo<BreakdownItem[]>(() => {
    const labels: Record<DashboardAgingBucket, string> = {
      current: tc.aging.current,
      '1-30': tc.aging.days.replace('{range}', '1–30'),
      '31-60': tc.aging.days.replace('{range}', '31–60'),
      '61-90': tc.aging.days.replace('{range}', '61–90'),
      '90+': tc.aging.days.replace('{range}', '90+'),
    };
    const item = (key: string, label: string, amount: number, color: string) => ({
      key,
      label,
      amount,
      display: formatMoney(amount),
      color,
    });
    if (summary?.aging) {
      return BUCKETS.map((b) => item(b, labels[b], Number(summary.aging?.[b].total ?? 0), BUCKET_COLORS[b]));
    }
    // An API without buckets still has the outstanding and overdue totals.
    const overdue = Number(summary?.overdue ?? 0);
    return [
      item('current', tc.aging.current, Number(summary?.outstanding ?? 0) - overdue, BUCKET_COLORS.current),
      item('overdue', tc.aging.overdue, overdue, BUCKET_COLORS['61-90']),
    ];
  }, [summary, tc.aging, formatMoney]);
}

function useCashItems(dashboard: Dashboard): BreakdownItem[] {
  const { formatMoney } = useChartFormat();
  const base = dashboard.currency;

  // Balances are in each account's currency: only base-currency accounts share the bar.
  return (dashboard.bankAccounts ?? []).map((account, index): BreakdownItem => {
    const amount = Number(account.currentBalance ?? 0);
    const inBase = !account.currency || !base || account.currency === base;
    return {
      key: account.id,
      label: account.name,
      amount: inBase ? amount : 0,
      display: formatMoney(amount, account.currency ?? undefined),
      color: inBase ? ACCOUNT_COLORS[index % ACCOUNT_COLORS.length] : 'var(--muted-foreground)',
    };
  });
}
