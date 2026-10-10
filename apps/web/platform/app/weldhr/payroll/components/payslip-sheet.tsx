/** Payslip preview: lines grouped by section in the current language, totals, year to date, and the PDF. */

import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayslip, HrPayslipLine } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { PAYSLIP_LABELS } from '@weldsuite/payroll-domain/labels';
import { useDownloadHrPayslipPdf, useHrPayslip } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage, formatDate } from '../../components/shared';
import { formatCents, formatDecimal, formatQuantity, humanizeKey, periodRange } from '../lib/format';
import { usePayrollLabels } from '../lib/use-payroll-labels';
import { IssueList, PayslipStatusBadge } from './payroll-ui';

type Section = HrPayslipLine['section'];

/** Employee-facing sections first, then what the employer pays on top, then information-only lines. */
const SECTION_ORDER: Section[] = ['earning', 'tax', 'deduction', 'reimbursement', 'employer', 'info'];

export function PayslipSheet({ payslipId, onClose }: Readonly<{ payslipId: string; onClose: () => void }>) {
  const t = useTranslations();
  const { data: payslip, isLoading, error } = useHrPayslip(payslipId);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{payslip ? payslip.employeeName : t('weldhr.payroll.payslip.title')}</SheetTitle>
          <SheetDescription>
            {payslip
              ? `${payslip.number ? `${payslip.number} · ` : ''}${periodRange(payslip.periodStart, payslip.periodEnd)}`
              : t('weldhr.payroll.payslip.description')}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {isLoading && (
            <div className="flex justify-center py-10">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          <ErrorBanner error={error ? errorMessage(error, t('weldhr.payroll.payslip.loadFailed')) : null} />
          {payslip && <PayslipBody payslip={payslip} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PayslipBody({ payslip }: Readonly<{ payslip: HrPayslip }>) {
  const t = useTranslations();
  const labels = usePayrollLabels();
  const download = useDownloadHrPayslipPdf();
  const currency = payslip.currency;

  const grouped = SECTION_ORDER.map((section) => ({ section, lines: payslip.lines.filter((line) => line.section === section) })).filter(
    (group) => group.lines.length > 0,
  );
  const ytdEntries = Object.entries(payslip.ytd).filter(([, cents]) => cents !== 0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <PayslipStatusBadge status={payslip.status} />
          <span>{payslip.employerName}</span>
          <span>· {t('weldhr.payroll.payslip.payDate', { date: formatDate(payslip.payDate) })}</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={download.isPending}
          onClick={() =>
            download.mutate(
              { id: payslip.id, number: payslip.number },
              { onError: (err) => toast.error(errorMessage(err, t('weldhr.payroll.payslip.pdfFailed'))) },
            )
          }
        >
          {download.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
          {t('weldhr.payroll.payslip.downloadPdf')}
        </Button>
      </div>

      {payslip.issues.length > 0 && <IssueList issues={payslip.issues} currency={currency} />}

      {grouped.map(({ section, lines }) => (
        <section key={section} className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`weldhr.payroll.sections.${section}`)}</h3>
          <ul className="divide-y rounded-md border">
            {lines.map((line, index) => (
              <li key={`${line.code}-${index}`} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p>{labels.line(line)}</p>
                  {(line.quantity !== null && line.quantity !== undefined) || (line.rate !== null && line.rate !== undefined) ? (
                    <p className="text-xs text-muted-foreground">
                      {[formatQuantity(line.quantity), line.rate === null || line.rate === undefined ? null : formatQuantity(line.rate)]
                        .filter((part) => part !== '—' && part !== null)
                        .join(' × ')}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 tabular-nums">{formatCents(line.amountCents, currency)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('weldhr.payroll.payslip.totals')}</h3>
        <dl className="space-y-1.5 rounded-md border p-3 text-sm">
          <TotalRow label={t('weldhr.payroll.common.gross')} value={formatDecimal(payslip.grossPay, currency)} />
          <TotalRow label={t('weldhr.payroll.payslip.taxableWage')} value={formatDecimal(payslip.taxableWage, currency)} muted />
          <TotalRow label={t('weldhr.payroll.common.taxes')} value={formatDecimal(payslip.employeeTaxes, currency)} />
          <TotalRow label={t('weldhr.payroll.common.deductions')} value={formatDecimal(payslip.employeeDeductions, currency)} />
          <TotalRow label={t('weldhr.payroll.common.reimbursements')} value={formatDecimal(payslip.reimbursements, currency)} />
          <TotalRow label={t('weldhr.payroll.common.net')} value={formatDecimal(payslip.netPay, currency)} strong />
          <div className="border-t pt-1.5" />
          <TotalRow label={t('weldhr.payroll.common.employerTaxes')} value={formatDecimal(payslip.employerTaxes, currency)} muted />
          <TotalRow label={t('weldhr.payroll.common.employerCost')} value={formatDecimal(payslip.employerCost, currency)} muted />
        </dl>
      </section>

      {ytdEntries.length > 0 && (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t('weldhr.payroll.payslip.ytd')}</summary>
          <dl className="space-y-1.5 border-t p-3 text-sm">
            {ytdEntries.map(([key, cents]) => (
              <TotalRow key={key} label={PAYSLIP_LABELS[key]?.[labels.lang] ?? humanizeKey(key)} value={formatCents(cents, currency)} />
            ))}
          </dl>
        </details>
      )}
    </>
  );
}

function TotalRow({ label, value, strong, muted }: Readonly<{ label: string; value: string; strong?: boolean; muted?: boolean }>) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={muted ? 'text-muted-foreground' : undefined}>{label}</dt>
      <dd className={strong ? 'text-base font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}
