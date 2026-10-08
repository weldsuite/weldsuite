import { useMemo } from 'react';
import { useBalanceSheetReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { balanceSheetRows, isComparing, type ReportRowModel } from '../components/report-model';
import { LedgerLink, ReportShell, ReportWarning } from '../components/report-shell';
import { ReportTable } from '../components/report-table';
import { ReportToolbar } from '../components/report-toolbar';
import { useReportExport } from '../components/use-report-export';
import { useReportHeadings } from '../components/use-report-headings';
import { useReportParams } from '../components/use-report-params';

export default function BalanceSheetReportPage() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { params, update, query } = useReportParams();
  const reportQuery = useBalanceSheetReport(query);
  const report = reportQuery.data;
  const { heading, headingsByKey } = useReportHeadings();

  const rows = useMemo(
    () =>
      report
        ? balanceSheetRows(report, {
            ...tr.statement,
            calculated: {
              calculated_retained_earnings: tr.statement.retainedEarningsEarlier,
              calculated_net_income: tr.statement.netIncomeThisYear,
            },
          })
        : [],
    [report, tr.statement],
  );
  const comparing = report ? isComparing(report.columns) : false;
  const periodLabel = report ? tr.asOfDate.replace('{date}', formatDate(report.asOf)) : undefined;

  const { busy, exportCsv, exportPdf } = useReportExport('balance-sheet', query, {
    periodLabel,
    columnLabels: report ? headingsByKey(report.columns) : undefined,
  });

  // An account links to its ledger up to the date of the sheet.
  const renderLabel = (row: ReportRowModel) =>
    row.accountId ? (
      <LedgerLink accountId={row.accountId} to={report?.asOf}>
        {row.code ? <span className="mr-2 font-mono text-xs text-muted-foreground">{row.code}</span> : null}
        {row.label}
      </LedgerLink>
    ) : (
      row.label
    );

  return (
    <ReportShell
      title={t.accounting.reports.balanceSheet}
      subtitle={report ? `${periodLabel} · ${report.basis === 'cash' ? tr.basisCash : tr.basisAccrual}` : undefined}
      isLoading={reportQuery.isLoading}
      isError={reportQuery.isError && !report}
      onRetry={() => void reportQuery.refetch()}
      toolbar={
        <ReportToolbar
          dates="asOf"
          params={params}
          onChange={update}
          defaults={{ asOf: report?.asOf, basis: report?.basis }}
          isFetching={reportQuery.isFetching && !reportQuery.isLoading}
          exportControls={{ onCsv: () => void exportCsv(), onPdf: () => void exportPdf(), busy, disabled: !report }}
        />
      }
    >
      {report ? (
        <div className="space-y-4">
          <ReportTable
            caption={t.accounting.reports.balanceSheet}
            columns={report.columns}
            rows={rows}
            comparing={comparing}
            heading={heading}
            formatMoney={formatMoney}
            labels={{ account: tr.colAccount, change: tr.colChange, changePercent: tr.colChangePercent }}
            renderLabel={renderLabel}
          />
          {!report.isBalanced ? (
            <ReportWarning>{tr.notBalanced.replace('{amount}', formatMoney(report.difference))}</ReportWarning>
          ) : null}
        </div>
      ) : null}
    </ReportShell>
  );
}
