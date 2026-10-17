/**
 * The top of the dashboard, laid out like Stripe's "Today": a header row
 * like "Your overview" (heading over a hairline), a metric picker with this
 * year's running total and last year's figure above the chart, then the
 * balances you act on (cash, receivables, payables, documents), each title
 * linking to its list.
 */

import { useMemo, useState } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { ComparisonLineChart } from './comparison-line-chart';
import { dashboardTrend, yearToDateSeries, type Metric } from './dashboard-series';
import { useChartFormat } from './use-chart-format';

export function TodaySection({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const format = useChartFormat();
  const [metric, setMetric] = useState<Metric>('revenue');

  const { months, sample } = useMemo(() => dashboardTrend(dashboard), [dashboard]);
  // The sample trend has all three metrics; an older API only returns revenue.
  const hasTrend = sample || Boolean(dashboard.monthlyTrend?.length);
  const activeMetric: Metric = hasTrend ? metric : 'revenue';
  const ytd = useMemo(() => yearToDateSeries(months, activeMetric), [months, activeMetric]);

  const metricLabels: Record<Metric, string> = {
    revenue: tc.revenue,
    expenses: tc.expenses,
    profit: tc.netProfit,
  };
  const through = ytd.throughMonth;
  // "Jan – Oct 2026": January of `year` up to this year's current month.
  const span = (year: number) => {
    if (!through) return '';
    const january = String(year) + '-01';
    const current = String(year) + through.slice(4);
    return `${format.monthShort(january)} – ${format.monthYear(current)}`;
  };

  return (
    <section className="min-w-0 space-y-14">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b pb-4">
        <h2 className="text-2xl font-medium leading-6">{tc.today}</h2>
      </div>

      <div className="space-y-6">
        <div className="flex flex-wrap gap-x-16 gap-y-4">
          <div className="space-y-1">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-1 text-sm font-medium outline-none hover:text-foreground/80">
                {metricLabels[activeMetric]}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup value={activeMetric} onValueChange={(v) => setMetric(v as Metric)}>
                  {(hasTrend ? (['revenue', 'expenses', 'profit'] as const) : (['revenue'] as const)).map((m) => (
                    <DropdownMenuRadioItem key={m} value={m}>
                      {metricLabels[m]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <p className={`text-xl tabular-nums ${(ytd.total ?? 0) < 0 ? 'text-destructive' : ''}`}>
              {ytd.total === null ? '—' : format.formatMoney(ytd.total)}
            </p>
            <p className="text-xs text-muted-foreground">{span(ytd.year)}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{tc.lastYear}</p>
            <p className="text-xl tabular-nums text-muted-foreground">
              {ytd.compareTotal === null ? '—' : format.formatMoney(ytd.compareTotal)}
            </p>
            <p className="text-xs text-muted-foreground">{ytd.compareTotal === null ? tc.noComparison : span(ytd.year - 1)}</p>
          </div>
        </div>

        <ComparisonLineChart
          variant="hero"
          points={ytd.points}
          label={metricLabels[activeMetric]}
          compareLabel={tc.lastYear}
          formatTick={format.monthShort}
          className="aspect-auto h-[200px] w-full"
        />
      </div>

      <Balances dashboard={dashboard} />
    </section>
  );
}

const plural = (forms: { one: string; other: string }, count: number) =>
  count === 1 ? forms.one : forms.other.replace('{count}', String(count));

/** Stripe's "EUR balance / EUR payouts" row: a title that links to the list, the figure, one muted line. */
function Balances({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const { formatMoney } = useChartFormat();

  const base = dashboard.currency;
  const accounts = dashboard.bankAccounts ?? [];
  const cash = accounts
    .filter((a) => !a.currency || !base || a.currency === base)
    .reduce((sum, a) => sum + Number(a.currentBalance ?? 0), 0);
  const receivables = dashboard.receivables;
  const payables = dashboard.payables;
  const overdue = Number(receivables?.overdue ?? 0);

  const items: Array<{
    key: string;
    label: string;
    value: string;
    sub: string;
    to: LinkProps['to'];
    warn?: boolean;
  }> = [
    {
      key: 'cash',
      label: tc.cashBalance,
      value: formatMoney(cash),
      sub: plural(tc.accounts, accounts.length),
      to: '/weldbooks/banking',
    },
    {
      key: 'receivables',
      label: tc.toReceive,
      value: formatMoney(Number(receivables?.outstanding ?? 0)),
      sub:
        overdue > 0
          ? tc.overdueAmount.replace('{amount}', formatMoney(overdue))
          : plural(tc.invoiceCount, receivables?.outstandingCount ?? 0),
      to: '/weldbooks/invoices',
      warn: overdue > 0,
    },
    {
      key: 'payables',
      label: tc.toPay,
      value: formatMoney(Number(payables?.outstanding ?? 0)),
      sub: plural(tc.billCount, payables?.outstandingCount ?? 0),
      to: '/weldbooks/bills',
    },
    {
      key: 'documents',
      label: tc.documents,
      value: String(dashboard.pendingDocuments ?? 0),
      sub: tc.documentsWaiting,
      to: '/weldbooks/documents',
    },
  ];

  return (
    <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.key} className="min-w-0 space-y-1">
          <Link to={item.to} className="block w-fit text-sm font-medium hover:underline">
            {item.label}
          </Link>
          <p className="text-xl tabular-nums">{item.value}</p>
          <p className={`text-xs ${item.warn ? 'text-destructive' : 'text-muted-foreground'}`}>{item.sub}</p>
        </div>
      ))}
    </div>
  );
}
