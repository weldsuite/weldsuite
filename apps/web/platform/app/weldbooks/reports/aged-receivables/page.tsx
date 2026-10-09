import { useAgedReceivablesReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { AgedReportView } from '../components/aged-report-view';
import { ReportShell } from '../components/report-shell';
import { ReportToolbar } from '../components/report-toolbar';
import { useReportExport } from '../components/use-report-export';
import { useReportParams } from '../components/use-report-params';

export default function AgedReceivablesReportPage() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const { formatDate } = useWeldbooksFormat();
  const { params, update, query } = useReportParams();
  const reportQuery = useAgedReceivablesReport(query);
  const report = reportQuery.data;
  const periodLabel = report ? tr.asOfDate.replace('{date}', formatDate(report.asOf)) : undefined;

  const { busy, exportCsv, exportPdf } = useReportExport('aged-receivables', query, { periodLabel });

  return (
    <ReportShell
      title={t.accounting.reports.agedReceivables}
      subtitle={periodLabel}
      isLoading={reportQuery.isLoading}
      isError={reportQuery.isError && !report}
      onRetry={() => void reportQuery.refetch()}
      toolbar={
        <ReportToolbar
          dates="asOf"
          params={params}
          onChange={update}
          defaults={{ asOf: report?.asOf }}
          showBasis={false}
          showCompare={false}
          showDimensions={false}
          isFetching={reportQuery.isFetching && !reportQuery.isLoading}
          exportControls={{ onCsv: () => void exportCsv(), onPdf: () => void exportPdf(), busy, disabled: !report }}
        />
      }
    >
      {report ? <AgedReportView report={report} kind="receivables" /> : null}
    </ReportShell>
  );
}
