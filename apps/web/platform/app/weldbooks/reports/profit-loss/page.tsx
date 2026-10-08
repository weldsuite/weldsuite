import { useMemo } from 'react';
import { useProfitLossReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { isComparing, profitLossRows, type ReportRowModel } from '../components/report-model';
import { ReportShell, LedgerLink } from '../components/report-shell';
import { ReportTable } from '../components/report-table';
import { ReportToolbar } from '../components/report-toolbar';
import { useReportExport } from '../components/use-report-export';
import { useReportHeadings } from '../components/use-report-headings';
import { useReportParams } from '../components/use-report-params';

export default function ProfitLossReportPage() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const { formatMoney } = useWeldbooksFormat();
  const { params, update, query } = useReportParams();
  const reportQuery = useProfitLossReport(query);
  const report = reportQuery.data;
  const { heading, headingsByKey, rangeLabel } = useReportHeadings();

  const rows = useMemo(() => (report ? profitLossRows(report, tr.statement) : []), [report, tr.statement]);
  const comparing = report ? isComparing(report.columns) : false;
  const periodLabel = report ? rangeLabel(report.period.from, report.period.to) : undefined;
  const hasActivity = !!report && (report.revenue.length > 0 || report.expenses.length > 0);

  const { busy, exportCsv, exportPdf } = useReportExport('profit-loss', query, {
    periodLabel,
    columnLabels: report ? headingsByKey(report.columns) : undefined,
  });

  const renderLabel = (row: ReportRowModel) =>
    row.accountId ? (
      <LedgerLink accountId={row.accountId} from={report?.period.from} to={report?.period.to}>
        {row.code ? <span className="mr-2 font-mono text-xs text-muted-foreground">{row.code}</span> : null}
        {row.label}
      </LedgerLink>
    ) : (
      row.label
    );

  return (
    <ReportShell
      title={t.accounting.reports.profitLoss}
      subtitle={report ? `${periodLabel} · ${report.basis === 'cash' ? tr.basisCash : tr.basisAccrual}` : undefined}
      isLoading={reportQuery.isLoading}
      isError={reportQuery.isError && !report}
      onRetry={() => void reportQuery.refetch()}
      toolbar={
        <ReportToolbar
          dates="period"
          params={params}
          onChange={update}
          defaults={{ from: report?.period.from, to: report?.period.to, basis: report?.basis }}
          showPeriods
          isFetching={reportQuery.isFetching && !reportQuery.isLoading}
          exportControls={{ onCsv: () => void exportCsv(), onPdf: () => void exportPdf(), busy, disabled: !report }}
        />
      }
    >
      {report && hasActivity ? (
        <ReportTable
          caption={t.accounting.reports.profitLoss}
          columns={report.columns}
          rows={rows}
          comparing={comparing}
          heading={heading}
          formatMoney={formatMoney}
          labels={{ account: tr.colAccount, change: tr.colChange, changePercent: tr.colChangePercent }}
          renderLabel={renderLabel}
        />
      ) : (
        <p className="rounded-md border p-8 text-center text-sm text-muted-foreground">{tr.noActivity}</p>
      )}
    </ReportShell>
  );
}
