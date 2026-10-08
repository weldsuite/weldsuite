import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useCashFlowReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { CashFlowMonth, ReportDelta } from '@/lib/weldbooks/report-types';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { ReportShell } from '../components/report-shell';
import { ReportToolbar } from '../components/report-toolbar';
import { useReportExport } from '../components/use-report-export';
import { useReportHeadings } from '../components/use-report-headings';
import { useReportParams } from '../components/use-report-params';

/** `+1,200.00 (+12.5%)`; the percent is left out when the comparison amount is zero. */
function deltaText(delta: ReportDelta, formatMoney: (value: string) => string): string {
  const n = Number(delta.amount);
  const amount = n > 0 ? `+${formatMoney(delta.amount)}` : formatMoney(delta.amount);
  if (delta.percent === null) return amount;
  return `${amount} (${delta.percent > 0 ? '+' : ''}${delta.percent}%)`;
}

function MonthlyTable({
  months,
  caption,
}: Readonly<{ months: readonly CashFlowMonth[]; caption: string }>) {
  const { t } = useI18n();
  const tb = t.accounting.reports;
  const { formatMoney, formatMonth } = useWeldbooksFormat();

  // Running balance: the net cash flow added up from the first month shown.
  const rows = useMemo(() => {
    let running = 0;
    return months.map((month) => {
      running += Number(month.net);
      return { month, running };
    });
  }, [months]);

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>{tb.colMonth}</TableHead>
            <TableHead className="text-right">{tb.colInflows}</TableHead>
            <TableHead className="text-right">{tb.colOutflows}</TableHead>
            <TableHead className="text-right">{tb.colNet}</TableHead>
            <TableHead className="text-right">{tb.colRunningBalance}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ month, running }) => (
            <TableRow key={month.month}>
              <TableCell>{/^\d{4}-\d{2}$/.test(month.month) ? formatMonth(`${month.month}-01`) : month.month}</TableCell>
              <TableCell className="text-right tabular-nums text-green-600 dark:text-green-400">{formatMoney(month.inflows)}</TableCell>
              <TableCell className="text-right tabular-nums text-red-600 dark:text-red-400">{formatMoney(month.outflows)}</TableCell>
              <TableCell
                className={cn(
                  'text-right tabular-nums',
                  Number(month.net) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
                )}
              >
                {formatMoney(month.net)}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right font-medium tabular-nums',
                  running >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
                )}
              >
                {formatMoney(running)}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                {tb.noData}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}

export default function CashFlowReportPage() {
  const { t } = useI18n();
  const tb = t.accounting.reports;
  const tr = t.weldbooksUs.reports;
  const { formatMoney } = useWeldbooksFormat();
  const { params, update, query } = useReportParams();
  const reportQuery = useCashFlowReport(query);
  const report = reportQuery.data;
  const { rangeLabel } = useReportHeadings();
  const periodLabel = report ? rangeLabel(report.period.from, report.period.to) : undefined;

  const { busy, exportCsv, exportPdf } = useReportExport('cash-flow', query, { periodLabel });

  const comparison = report?.comparison;
  const cards = report
    ? [
        { key: 'inflows' as const, label: tb.totalInflows, value: report.totals.inflows, tone: 'text-green-600 dark:text-green-400' },
        { key: 'outflows' as const, label: tb.totalOutflows, value: report.totals.outflows, tone: 'text-red-600 dark:text-red-400' },
        {
          key: 'net' as const,
          label: tb.netCashFlow,
          value: report.totals.net,
          tone: Number(report.totals.net) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
        },
      ]
    : [];

  return (
    <ReportShell
      title={tb.cashFlow}
      subtitle={periodLabel}
      isLoading={reportQuery.isLoading}
      isError={reportQuery.isError && !report}
      onRetry={() => void reportQuery.refetch()}
      toolbar={
        <ReportToolbar
          dates="period"
          params={params}
          onChange={update}
          defaults={{ from: report?.period.from, to: report?.period.to }}
          showBasis={false}
          showDimensions={false}
          isFetching={reportQuery.isFetching && !reportQuery.isLoading}
          exportControls={{ onCsv: () => void exportCsv(), onPdf: () => void exportPdf(), busy, disabled: !report }}
        />
      }
    >
      {report ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {cards.map((card) => (
              <Card key={card.key}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground">{card.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className={cn('text-2xl font-semibold tabular-nums', card.tone)}>{formatMoney(card.value)}</p>
                  {comparison ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {tr.vsComparison
                        .replace('{amount}', formatMoney(comparison.totals[card.key]))
                        .replace('{change}', deltaText(comparison.delta[card.key], formatMoney))}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>

          <section aria-labelledby="cash-flow-monthly" className="space-y-2">
            <h2 id="cash-flow-monthly" className="text-base font-semibold">{tb.monthlyBreakdown}</h2>
            <MonthlyTable months={report.monthly} caption={tb.monthlyBreakdown} />
          </section>

          {comparison ? (
            <section aria-labelledby="cash-flow-comparison" className="space-y-2">
              <h2 id="cash-flow-comparison" className="text-base font-semibold">
                {tr.comparisonPeriod.replace('{period}', rangeLabel(comparison.period.from, comparison.period.to))}
              </h2>
              <MonthlyTable months={comparison.monthly} caption={tr.comparisonPeriod.replace('{period}', '')} />
            </section>
          ) : null}
        </div>
      ) : null}
    </ReportShell>
  );
}
