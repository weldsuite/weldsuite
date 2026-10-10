/**
 * Employee detail — Payroll tab: payroll profile, compensation history,
 * recurring components, tax elections, payment details and payslips.
 * Visible with payroll:read; editing needs payroll:prepare.
 */

import { useState } from 'react';
import { Banknote, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { useHrPayrollEmployee } from '@/hooks/queries/use-weldhr-payroll-queries';
import { CompensationCard, ComponentsCard } from '../../payroll/employee/pay-cards';
import { ElectionsCard } from '../../payroll/employee/elections-card';
import { PaymentDetailsCard } from '../../payroll/employee/payment-details-card';
import { PayslipsCard } from '../../payroll/employee/payslips-card';
import { ProfileCard } from '../../payroll/employee/profile-card';
import { ProfileDialog } from '../../payroll/employee/profile-dialog';
import { emptyIcon } from '../page-kit';
import { ErrorBanner, errorMessage } from '../shared';

export function EmployeePayrollTab({ employeeId }: Readonly<{ employeeId: string }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const canEdit = can('payroll:prepare');
  const { data: detail, isLoading, error } = useHrPayrollEmployee(employeeId);
  const [editingProfile, setEditingProfile] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!detail) return <ErrorBanner error={errorMessage(error, t('weldhr.payroll.employee.loadFailed'))} />;

  // Not on payroll yet: one call to action, nothing else to show.
  if (!detail.profile) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
        {emptyIcon(Banknote)}
        <h2 className="mb-1.5 text-[15px] font-semibold">{t('weldhr.payroll.employee.notOnPayroll.title')}</h2>
        <p className="mb-4 max-w-md text-sm leading-relaxed text-muted-foreground">
          {canEdit ? t('weldhr.payroll.employee.notOnPayroll.description') : t('weldhr.payroll.employee.notOnPayroll.noPermission')}
        </p>
        {canEdit && <Button onClick={() => setEditingProfile(true)}>{t('weldhr.payroll.employee.notOnPayroll.cta')}</Button>}
        {editingProfile && <ProfileDialog employeeId={employeeId} detail={detail} onClose={() => setEditingProfile(false)} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ProfileCard detail={detail} canEdit={canEdit} onEdit={() => setEditingProfile(true)} />
      <div className="grid gap-4 xl:grid-cols-2">
        <CompensationCard employeeId={employeeId} detail={detail} canEdit={canEdit} />
        <ComponentsCard employeeId={employeeId} detail={detail} canEdit={canEdit} />
      </div>
      <ElectionsCard employeeId={employeeId} detail={detail} canEdit={canEdit} />
      <PaymentDetailsCard employeeId={employeeId} detail={detail} canEdit={canEdit} />
      <PayslipsCard employeeId={employeeId} detail={detail} />
      {editingProfile && <ProfileDialog employeeId={employeeId} detail={detail} onClose={() => setEditingProfile(false)} />}
    </div>
  );
}
