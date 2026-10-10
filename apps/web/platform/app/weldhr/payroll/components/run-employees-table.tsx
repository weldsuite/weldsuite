/**
 * The employees of a pay run: gross, taxes, net, employer cost and the change
 * against the previous net pay, with per-row issue badges, an include/exclude
 * switch while the run can still change, and the inputs and payslip drawers.
 */

import { Link } from '@tanstack/react-router';
import { ListPlus, ReceiptText } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayRunDetail, HrPayslipSummary } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { cn } from '@/lib/utils';
import { EmptyText } from '../../components/page-kit';
import { formatDecimal, formatSignedDecimal } from '../lib/format';
import { usePayrollLabels } from '../lib/use-payroll-labels';
import { IssueCountBadges } from './payroll-ui';

/** A change of more than this share of the previous net pay is flagged. */
const LARGE_CHANGE = 0.1;

function Variance({ payslip, currency }: Readonly<{ payslip: HrPayslipSummary; currency: string }>) {
  const t = useTranslations();
  if (payslip.previousNetPay === null) return <span className="text-muted-foreground">{t('weldhr.payroll.run.employees.firstPayslip')}</span>;
  const previous = Number(payslip.previousNetPay);
  const diff = Number(payslip.netPay) - previous;
  if (!Number.isFinite(diff) || !Number.isFinite(previous)) return <span className="text-muted-foreground">—</span>;
  const ratio = previous === 0 ? (diff === 0 ? 0 : 1) : Math.abs(diff) / Math.abs(previous);
  return (
    <span className={cn('tabular-nums', ratio >= LARGE_CHANGE ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
      {formatSignedDecimal(diff, currency)}
      {previous !== 0 && ` (${diff >= 0 ? '+' : '−'}${(ratio * 100).toFixed(1)}%)`}
    </span>
  );
}

export function RunEmployeesTable({
  run,
  canExclude,
  togglingId,
  onToggle,
  onOpenInputs,
  onOpenPayslip,
}: Readonly<{
  run: HrPayRunDetail;
  /** The run is still draft or calculated and the caller may prepare payroll. */
  canExclude: boolean;
  togglingId: string | null;
  onToggle: (employeeId: string, excluded: boolean) => void;
  onOpenInputs: (employeeId: string, name: string) => void;
  onOpenPayslip: (payslipId: string) => void;
}>) {
  const t = useTranslations();
  const labels = usePayrollLabels();

  if (run.employees.length === 0) return <EmptyText>{t('weldhr.payroll.run.employees.empty')}</EmptyText>;

  const payslipByEmployee = new Map(run.payslips.map((payslip) => [payslip.employeeId, payslip]));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('weldhr.payroll.common.employee')}</TableHead>
          <TableHead className="text-right">{t('weldhr.payroll.common.gross')}</TableHead>
          <TableHead className="text-right">{t('weldhr.payroll.common.taxes')}</TableHead>
          <TableHead className="text-right">{t('weldhr.payroll.common.net')}</TableHead>
          <TableHead className="text-right">{t('weldhr.payroll.common.employerCost')}</TableHead>
          <TableHead className="text-right">{t('weldhr.payroll.run.employees.variance')}</TableHead>
          <TableHead>{t('weldhr.payroll.run.employees.issues')}</TableHead>
          <TableHead className="text-right">{t('weldhr.payroll.run.employees.included')}</TableHead>
          <TableHead className="w-px" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {run.employees.map((employee) => {
          const payslip = payslipByEmployee.get(employee.employeeId);
          const issues = payslip && payslip.issues.length > 0 ? payslip.issues : employee.issues;
          const included = !employee.excluded;
          return (
            <TableRow key={employee.employeeId} className={cn(!included && 'text-muted-foreground')}>
              <TableCell>
                <Link
                  to="/weldhr/employees/$employeeId"
                  params={{ employeeId: employee.employeeId }}
                  search={{ tab: 'payroll' }}
                  className="font-medium hover:underline"
                >
                  {employee.displayName}
                </Link>
                {!included && <span className="ml-2 text-xs">{t('weldhr.payroll.run.employees.excluded')}</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{payslip && included ? formatDecimal(payslip.grossPay, run.currency) : '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{payslip && included ? formatDecimal(payslip.employeeTaxes, run.currency) : '—'}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{payslip && included ? formatDecimal(payslip.netPay, run.currency) : '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{payslip && included ? formatDecimal(payslip.employerCost, run.currency) : '—'}</TableCell>
              <TableCell className="text-right">{payslip && included ? <Variance payslip={payslip} currency={run.currency} /> : '—'}</TableCell>
              <TableCell>
                {/* The text of each issue is the tooltip; the full list is in the issues panel above. */}
                <span title={issues.map((issue) => labels.issue(issue, run.currency)).join('\n')}>
                  <IssueCountBadges issues={issues} />
                </span>
              </TableCell>
              <TableCell className="text-right">
                <Switch
                  checked={included}
                  disabled={!canExclude || togglingId === employee.employeeId}
                  onCheckedChange={(next) => onToggle(employee.employeeId, !next)}
                  aria-label={t('weldhr.payroll.run.employees.includeAria', { name: employee.displayName })}
                />
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  {included && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onOpenInputs(employee.employeeId, employee.displayName)}>
                      <ListPlus className="mr-1 h-3.5 w-3.5" />
                      {t('weldhr.payroll.run.employees.inputs')}
                    </Button>
                  )}
                  {payslip && included && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onOpenPayslip(payslip.id)}>
                      <ReceiptText className="mr-1 h-3.5 w-3.5" />
                      {t('weldhr.payroll.run.employees.payslip')}
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
