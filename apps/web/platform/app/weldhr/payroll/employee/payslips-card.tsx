/** Employee Payroll tab — the employee's payslips (preview, PDF) and annual statements (jaaropgaaf, W-2). */

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Loader2, ReceiptText } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import {
  useDownloadHrAnnualStatementPdf,
  useDownloadHrPayslipPdf,
  useHrAnnualStatements,
  useHrEmployeePayslips,
} from '@/hooks/queries/use-weldhr-payroll-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate } from '../../components/shared';
import { PayslipSheet } from '../components/payslip-sheet';
import { PayslipStatusBadge } from '../components/payroll-ui';
import { formatDecimal, periodRange } from '../lib/format';

export function PayslipsCard({ employeeId, detail }: Readonly<{ employeeId: string; detail: HrPayrollEmployeeDetail }>) {
  const t = useTranslations();
  const { data: payslips, isLoading, error } = useHrEmployeePayslips(employeeId);
  const { data: statements } = useHrAnnualStatements(employeeId);
  const [openId, setOpenId] = useState<string | null>(null);
  const pdf = useDownloadHrPayslipPdf();
  const statementPdf = useDownloadHrAnnualStatementPdf();
  const fallbackCurrency = detail.employer?.currency ?? 'EUR';

  return (
    <SectionCard title={t('weldhr.payroll.employee.payslips.title')} contentClassName="p-0">
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.payroll.employee.payslips.loadFailed')) : null} />
      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {payslips && payslips.length === 0 && <EmptyText>{t('weldhr.payroll.employee.payslips.empty')}</EmptyText>}
      {payslips && payslips.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('weldhr.payroll.common.period')}</TableHead>
              <TableHead>{t('weldhr.payroll.common.payDate')}</TableHead>
              <TableHead>{t('weldhr.payroll.employee.payslips.number')}</TableHead>
              <TableHead className="text-right">{t('weldhr.payroll.common.gross')}</TableHead>
              <TableHead className="text-right">{t('weldhr.payroll.common.net')}</TableHead>
              <TableHead>{t('weldhr.payroll.common.status')}</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {payslips.map((payslip) => (
              <TableRow key={payslip.id}>
                <TableCell className="whitespace-nowrap">{periodRange(payslip.periodStart, payslip.periodEnd)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(payslip.payDate)}</TableCell>
                <TableCell className="text-muted-foreground">{payslip.number ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDecimal(payslip.grossPay, payslip.currency || fallbackCurrency)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatDecimal(payslip.netPay, payslip.currency || fallbackCurrency)}</TableCell>
                <TableCell>
                  <PayslipStatusBadge status={payslip.status} />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpenId(payslip.id)}>
                      <ReceiptText className="mr-1 h-3.5 w-3.5" />
                      {t('weldhr.payroll.run.employees.payslip')}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t('weldhr.payroll.payslip.downloadPdf')}
                      disabled={pdf.isPending}
                      onClick={() => pdf.mutate({ id: payslip.id, number: payslip.number }, { onError: (err) => toast.error(errorMessage(err, t('weldhr.payroll.payslip.pdfFailed'))) })}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {statements && statements.length > 0 && (
        <div className="border-t px-6 py-4">
          <p className="mb-2 text-sm font-medium">{t('weldhr.payroll.employee.payslips.annualStatements')}</p>
          <ul className="flex flex-wrap gap-2">
            {statements.map((statement) => (
              <li key={`${statement.employerId}-${statement.year}`}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={statementPdf.isPending}
                  onClick={() =>
                    statementPdf.mutate(
                      { employeeId, year: statement.year, employerId: statement.employerId },
                      { onError: (err) => toast.error(errorMessage(err, t('weldhr.payroll.employee.payslips.statementFailed'))) },
                    )
                  }
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {t(`weldhr.payroll.annualStatement.${statement.kind}`, { year: statement.year })}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {openId && <PayslipSheet payslipId={openId} onClose={() => setOpenId(null)} />}
    </SectionCard>
  );
}
