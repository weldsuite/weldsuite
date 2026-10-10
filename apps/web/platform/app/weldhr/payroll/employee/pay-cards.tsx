/** Employee Payroll tab — compensation history and the recurring pay components. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { componentDef } from '@weldsuite/payroll-domain/components';
import type { HrPayComponent, HrPayrollEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDeleteHrCompensation, useDeleteHrPayComponent } from '@/hooks/queries/use-weldhr-payroll-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { errorMessage, formatDate } from '../../components/shared';
import { formatDecimal, formatPercent } from '../lib/format';
import { usePayrollLabels } from '../lib/use-payroll-labels';
import { ComponentDialog } from './component-dialog';
import { CompensationDialog } from './compensation-dialog';

export function CompensationCard({ employeeId, detail, canEdit }: Readonly<{ employeeId: string; detail: HrPayrollEmployeeDetail; canEdit: boolean }>) {
  const t = useTranslations();
  const [adding, setAdding] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const remove = useDeleteHrCompensation();
  const currency = detail.employer?.currency ?? 'EUR';

  return (
    <SectionCard
      title={t('weldhr.payroll.employee.compensation.title')}
      contentClassName="p-0"
      action={
        canEdit && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.payroll.employee.compensation.add')}
          </Button>
        )
      }
    >
      {detail.compensations.length === 0 ? (
        <EmptyText>{t('weldhr.payroll.employee.compensation.empty')}</EmptyText>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('weldhr.payroll.employee.compensation.effectiveFrom')}</TableHead>
              <TableHead>{t('weldhr.payroll.employee.compensation.payType')}</TableHead>
              <TableHead className="text-right">{t('weldhr.payroll.employee.compensation.rate')}</TableHead>
              <TableHead>{t('weldhr.payroll.employee.compensation.reason')}</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.compensations.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDate(row.effectiveFrom)}
                  {row.effectiveTo === null && <Badge className="ml-2" variant="outline">{t('weldhr.payroll.employee.compensation.current')}</Badge>}
                </TableCell>
                <TableCell>{t(`weldhr.payroll.employee.compensation.${row.payType}`)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatDecimal(row.amount, row.currency || currency)}
                  <span className="text-muted-foreground"> / {t(`weldhr.payroll.period.${row.period}`)}</span>
                </TableCell>
                <TableCell className="max-w-[16rem] truncate text-muted-foreground">{row.reason ?? '—'}</TableCell>
                <TableCell>
                  {canEdit && (
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t('weldhr.common.delete')} onClick={() => setDeleteId(row.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {adding && <CompensationDialog employeeId={employeeId} detail={detail} onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={t('weldhr.payroll.employee.compensation.deleteTitle')}
        description={t('weldhr.payroll.employee.compensation.deleteDescription')}
        variant="destructive"
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        onConfirm={async () => {
          if (!deleteId) return;
          try {
            await remove.mutateAsync(deleteId);
            setDeleteId(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.payroll.employee.compensation.deleteFailed')));
          }
        }}
      />
    </SectionCard>
  );
}

/** One line summarising a component's amount and parameters. */
function componentSummary(component: HrPayComponent, currency: string, t: (key: string) => string): string {
  const def = componentDef(component.code);
  const parts: string[] = [];
  if (component.amount !== null) parts.push(formatDecimal(component.amount, currency));
  for (const param of def?.params ?? []) {
    const value = component.params[param.key];
    if (value === null || value === undefined || value === '') continue;
    const label = t(`weldhr.payroll.params.${param.key}`);
    if (param.type === 'money') parts.push(`${label}: ${formatDecimal(Number(value), currency)}`);
    else if (param.type === 'percent') parts.push(`${label}: ${formatPercent(Number(value))}`);
    else parts.push(`${label}: ${String(value)}`);
  }
  return parts.join(' · ');
}

export function ComponentsCard({ employeeId, detail, canEdit }: Readonly<{ employeeId: string; detail: HrPayrollEmployeeDetail; canEdit: boolean }>) {
  const t = useTranslations();
  const labels = usePayrollLabels();
  const [dialog, setDialog] = useState<{ component: HrPayComponent | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrPayComponent | null>(null);
  const remove = useDeleteHrPayComponent();
  const country = detail.employer?.country;
  const currency = detail.employer?.currency ?? 'EUR';

  return (
    <SectionCard
      title={t('weldhr.payroll.employee.components.title')}
      contentClassName="p-0"
      action={
        canEdit &&
        country && (
          <Button size="sm" variant="outline" onClick={() => setDialog({ component: null })}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.payroll.employee.components.add')}
          </Button>
        )
      }
    >
      {detail.components.length === 0 ? (
        <EmptyText>{t('weldhr.payroll.employee.components.empty')}</EmptyText>
      ) : (
        <ul className="divide-y">
          {detail.components.map((component) => (
            <li key={component.id} className="flex items-start justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{component.label ?? labels.component(component.code)}</p>
                <p className="text-xs text-muted-foreground">{componentSummary(component, currency, t) || '—'}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(component.effectiveFrom)}
                  {component.effectiveTo ? ` – ${formatDate(component.effectiveTo)}` : ` – ${t('weldhr.payroll.employee.components.ongoing')}`}
                </p>
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t('weldhr.common.edit')} onClick={() => setDialog({ component })}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t('weldhr.common.delete')} onClick={() => setDeleteTarget(component)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {dialog && country && (
        <ComponentDialog employeeId={employeeId} country={country} currency={currency} component={dialog.component} onClose={() => setDialog(null)} />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.payroll.employee.components.deleteTitle')}
        description={t('weldhr.payroll.employee.components.deleteDescription')}
        variant="destructive"
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await remove.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.payroll.employee.components.deleteFailed')));
          }
        }}
      />
    </SectionCard>
  );
}
