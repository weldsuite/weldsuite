import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { countryName } from '@/components/address/countries';
import { useI18n } from '@/lib/i18n/provider';
import { downloadBlob } from '@/lib/weldbooks/download';
import { downloadPdf } from '@/lib/weldbooks/invoice-pdf';
import { buildReportPdf } from '@/lib/weldbooks/report-pdf';
import type { ReportName, ReportQuery } from '@/lib/weldbooks/report-types';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

interface UseReportExportOptions {
  /** English period line of the print document replaced by a translated, localized one. */
  periodLabel?: string;
  /** Headings of the value columns, by column key; merged over the translated defaults. */
  columnLabels?: Record<string, string>;
}

/**
 * CSV and PDF export of a report. CSV is the server's download (UTF-8 with a
 * byte order mark); PDF renders the server's print document with pdf-lib.
 * Both export every line of the period, whatever page is on screen.
 */
export function useReportExport(name: ReportName, query: ReportQuery, options: UseReportExportOptions = {}) {
  const { t, language } = useI18n();
  const tr = t.weldbooksUs.reports;
  const { labels } = useJurisdictionLabels();
  const { formatDate, dateLocale } = useWeldbooksFormat();
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null);

  const fail = useCallback(
    (err: unknown) => toast.error(tr.exportFailed, { description: err instanceof Error ? err.message : undefined }),
    [tr.exportFailed],
  );

  const exportCsv = useCallback(async () => {
    setBusy('csv');
    try {
      const { blob, filename } = await accountingApi.downloadReportCsv(name, query);
      downloadBlob(blob, filename ?? `${name}.csv`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }, [name, query, fail]);

  const exportPdf = useCallback(async () => {
    setBusy('pdf');
    try {
      const res = await accountingApi.getReportPrintDocument(name, query);
      const doc = res.data;
      const bytes = await buildReportPdf(doc, {
        labels: {
          basis: { cash: tr.pdf.basisCash, accrual: tr.pdf.basisAccrual },
          amountsIn: tr.pdf.amountsIn,
          generated: tr.pdf.generated,
          page: tr.pdf.page,
          taxId: labels.taxId,
          dba: tr.pdf.dba,
          account: tr.colAccount,
        },
        locale: dateLocale,
        formatDate: (value) => formatDate(value),
        periodLabel: options.periodLabel,
        columnLabels: {
          delta: tr.colChange,
          deltaPercent: tr.colChangePercent,
          debit: t.accounting.reports.debit,
          credit: t.accounting.reports.credit,
          balance: t.accounting.reports.colBalance,
          date: t.accounting.reports.colDate,
          entry: t.accounting.reports.colEntryNumber,
          inflows: t.accounting.reports.colInflows,
          outflows: t.accounting.reports.colOutflows,
          net: t.accounting.reports.colNet,
          total: t.accounting.reports.total,
          current: t.accounting.reports.bucketCurrent,
          '1-30': t.accounting.reports.bucket1_30,
          '31-60': t.accounting.reports.bucket31_60,
          '61-90': t.accounting.reports.bucket61_90,
          '90+': t.accounting.reports.bucketOver90,
          ...options.columnLabels,
        },
        countryName: (code) => countryName(code, language || 'en'),
      });
      downloadPdf(bytes, `${name}-${doc.generatedAt.slice(0, 10)}.pdf`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }, [name, query, tr, t.accounting.reports, labels.taxId, dateLocale, formatDate, language, options.periodLabel, options.columnLabels, fail]);

  return { busy, exportCsv, exportPdf };
}
