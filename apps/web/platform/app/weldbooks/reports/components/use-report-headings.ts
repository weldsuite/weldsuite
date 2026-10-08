import { useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import type { ReportColumn } from '@/lib/weldbooks/report-types';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { columnHeading } from './report-model';

/** Headings of a report's value columns in the entity's date format. */
export function useReportHeadings() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const { formatDate, formatMonth } = useWeldbooksFormat();

  const heading = useCallback(
    (column: ReportColumn) =>
      columnHeading(
        column,
        { total: tr.columnTotal, quarter: tr.quarterHeading, period: tr.periodHeading },
        { formatDate: (value) => formatDate(value), formatMonth: (value) => formatMonth(value) },
      ),
    [tr.columnTotal, tr.quarterHeading, tr.periodHeading, formatDate, formatMonth],
  );

  /** The headings by column key, for the PDF. */
  const headingsByKey = useCallback(
    (columns: readonly ReportColumn[]) => Object.fromEntries(columns.map((c) => [c.key, heading(c)])),
    [heading],
  );

  /** `1 Jan 2026 – 31 Dec 2026`, or the single date. */
  const rangeLabel = useCallback(
    (from: string | null | undefined, to: string) =>
      from && from !== to ? `${formatDate(from)} – ${formatDate(to)}` : formatDate(to),
    [formatDate],
  );

  return { heading, headingsByKey, rangeLabel };
}
