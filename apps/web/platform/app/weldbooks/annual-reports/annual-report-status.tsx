import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { useI18n } from '@/lib/i18n/provider';
import type { AnnualReportStatus } from '@/lib/weldbooks/annual-report-model';

/** The status of an annual report as a chip: draft, submitted, accepted, rejected or filed. */
export function AnnualReportStatusChip({ status }: Readonly<{ status: AnnualReportStatus }>) {
  const { t } = useI18n();
  return <StatusChip status={status}>{t.weldbooksNl.annualReports.statuses[status] ?? status}</StatusChip>;
}
