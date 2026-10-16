/**
 * Stripe's "Your overview": a heading, the date range and compare pills, and a
 * grid of blocks straight on the page, no backdrop or borders.
 *
 * - Revenue, expenses and net profit are line cards over the chosen range:
 *   the total, its change against the comparison and the comparison's total,
 *   then the chart. The pills drive them.
 * - Receivables and payables by age and cash per account are breakdown cards,
 *   as of today, so the range does not change them.
 */

import { useMemo, useState } from 'react';
import type { Dashboard, DashboardAgingBucket } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { BreakdownList, type BreakdownItem } from './breakdown-list';
import { ComparisonLineChart } from './comparison-line-chart';
import { percentChange, rangeSeries, trendMonths, type Compare, type Metric, type TrendMonth } from './dashboard-series';
import { FilterPill } from './filter-pill';
import { OverviewCard } from './overview-card';
import { useChartFormat } from './use-chart-format';

type Range = '3' | '6' | '12';

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

export function OverviewSection({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const [range, setRange] = useState<Range>('12');
  const [compareChoice, setCompareChoice] = useState<Compare | 'off'>('previousPeriod');
  const compare = compareChoice === 'off' ? null : compareChoice;
  const months = useMemo(() => trendMonths(dashboard), [dashboard]);

  const rangeOptions = [
    { value: '3' as const, label: tc.last3Months },
    { value: '6' as const, label: tc.last6Months },
    { value: '12' as const, label: tc.last12Months },
  ];
  const compareOptions = [
    { value: 'previousPeriod' as const, label: tc.previousPeriod },
    { value: 'previousYear' as const, label: tc.previousYear },
    { value: 'off' as const, label: tc.compareOff },
  ];

  return (
    <section className="space-y-14">
      <div className="space-y-3 border-b pb-4">
        <h2 className="text-lg font-medium">{tc.overview}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <FilterPill label={tc.dateRange} value={range} options={rangeOptions} onChange={setRange} />
          <FilterPill label={tc.compare} value={compareChoice} options={compareOptions} onChange={setCompareChoice} />
        </div>
      </div>

      <div className="grid gap-x-12 gap-y-14 md:grid-cols-2 lg:grid-cols-3">
        {(['revenue', 'expenses', 'profit'] as const).map((metric) => (
          <MetricCard
            key={metric}
            metric={metric}
            months={months}
            size={Number(range)}
            compare={compare}
          />
        ))}
        <AgingCard side="receivables" dashboard={dashboard} />
        <AgingCard side="payables" dashboard={dashboard} />
        <CashCard dashboard={dashboard} />
      </div>
    </section>
  );
}

function MetricCard({
  metric,
  months,
  size,
  compare,
}: Readonly<{ metric: Metric; months: TrendMonth[]; size: number; compare: Compare | null }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const format = useChartFormat();
  const series = useMemo(() => rangeSeries(months, metric, size, compare), [months, metric, size, compare]);
  // A month the API has no figure for draws as zero, like a month with nothing booked: the card
  // always shows a total and a line, never an empty state.
  const total = series.total ?? 0;
  const points = useMemo(() => series.points.map((p) => ({ ...p, value: p.value ?? 0 })), [series.points]);

  const titles: Record<Metric, string> = { revenue: tc.revenue, expenses: tc.expenses, profit: tc.netProfit };
  const infos: Record<Metric, string> = { revenue: tc.info.revenue, expenses: tc.info.expenses, profit: tc.info.profit };
  const change = percentChange(series.total, series.compareTotal);
  const compareText = compare === 'previousYear' ? tc.previousYearValue : tc.previousPeriodValue;

  return (
    <OverviewCard title={titles[metric]} info={infos[metric]} to="/weldbooks/reports/profit-loss">
      <div className="flex items-baseline gap-2">
        <span className={`text-xl font-semibold tabular-nums ${total < 0 ? 'text-destructive' : ''}`}>{format.formatMoney(total)}</span>
        {change !== null && (
          <span className={`text-sm font-medium tabular-nums ${changeTone(metric, change)}`}>{format.percent(change)}</span>
        )}
      </div>
      {compare && (
        <p className="mt-0.5 text-sm text-muted-foreground">
          {series.compareTotal === null ? tc.noComparison : compareText.replace('{amount}', format.formatMoney(series.compareTotal))}
        </p>
      )}
      <ComparisonLineChart
        variant="card"
        points={points}
        label={titles[metric]}
        compareLabel={compare === 'previousYear' ? tc.previousYear : tc.previousPeriod}
        formatTick={format.monthYear}
        className="mt-4 aspect-auto h-[160px] w-full"
      />
    </OverviewCard>
  );
}

/** Up is good for revenue and profit and bad for expenses; no change stays muted. */
function changeTone(metric: Metric, change: number): string {
  if (change === 0) return 'text-muted-foreground';
  const good = metric === 'expenses' ? change < 0 : change > 0;
  return good ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive';
}

function AgingCard({
  side,
  dashboard,
}: Readonly<{ side: 'receivables' | 'payables'; dashboard: Dashboard }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const { formatMoney } = useChartFormat();
  const summary = dashboard[side];

  const items = useMemo<BreakdownItem[]>(() => {
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

  const receivables = side === 'receivables';
  return (
    <OverviewCard
      title={receivables ? tc.receivablesByAge : tc.payablesByAge}
      info={receivables ? tc.info.receivables : tc.info.payables}
      to={receivables ? '/weldbooks/reports/aged-receivables' : '/weldbooks/reports/aged-payables'}
    >
      <BreakdownList items={items} />
    </OverviewCard>
  );
}

function CashCard({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  const { formatMoney } = useChartFormat();
  const base = dashboard.currency;

  // Balances are in each account's currency: only base-currency accounts share the bar.
  const items = (dashboard.bankAccounts ?? []).map((account, index): BreakdownItem => {
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

  return (
    <OverviewCard
      title={td.charts.cash}
      info={td.charts.info.cash}
      to="/weldbooks/banking"
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.noBankAccounts}</p>
      ) : (
        <BreakdownList items={items} />
      )}
    </OverviewCard>
  );
}
