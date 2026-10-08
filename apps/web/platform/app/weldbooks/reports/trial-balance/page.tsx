import { useMemo } from 'react';
import { useTrialBalanceReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { isComparing, trialBalanceRows, type ReportRowModel } from '../components/report-model';
import { LedgerLink, ReportShell, ReportWarning } from '../components/report-shell';
import { ReportTable } from '../components/report-table';
import { ReportToolbar } from '../components/report-toolbar';
import { useReportExport } from '../components/use-report-export';
import { useReportHeadings } from '../components/use-report-headings';
import { useReportParams } from '../components/use-report-params';

export default function TrialBalanceReportPage() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const { formatMoney } = useWeldbooksFormat();
  const { params, update, query } = useReportParams();
  const reportQuery = useTrialBalanceReport(query);
  const report = reportQuery.data;
  const { heading, headingsByKey, rangeLabel } = useReportHeadings();

  const model = useMemo(
    () => (report ? trialBalanceRows(report, { total: t.accounting.reports.totals }) : null),
    [report, t.accounting.reports.totals],
  );
  const comparing = report ? isComparing(report.columns) : false;
  const periodLabel = report ? rangeLabel(report.period.from, report.period.to) : undefined;

  const { busy, exportCsv, exportPdf } = useReportExport('trial-balance', query, {
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
      title={t.accounting.reports.trialBalance}
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
          isFetching={reportQuery.isFetching && !reportQuery.isLoading}
          exportControls={{ onCsv: () => void exportCsv(), onPdf: () => void exportPdf(), busy, disabled: !report }}
        />
      }
    >
      {report && model ? (
        report.accounts.length === 0 ? (
          <p className="rounded-md border p-8 text-center text-sm text-muted-foreground">{tr.noActivity}</p>
        ) : (
          <div className="space-y-4">
            <ReportTable
              caption={t.accounting.reports.trialBalance}
              columns={report.columns}
              rows={model.rows}
              comparing={comparing}
              heading={heading}
              formatMoney={formatMoney}
              labels={{ account: tr.colAccount, change: tr.colChange, changePercent: tr.colChangePercent }}
              renderLabel={renderLabel}
              valueColumns={
                model.debitCredit
                  ? [
                      { key: 'debit', heading: t.accounting.reports.debit },
                      { key: 'credit', heading: t.accounting.reports.credit },
                    ]
                  : undefined
              }
            />
            {!report.isBalanced ? <ReportWarning>{tr.trialBalanceOff}</ReportWarning> : null}
          </div>
        )
      ) : null}
    </ReportShell>
  );
}
