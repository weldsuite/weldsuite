/**
 * WeldHR Payroll — Settings: the employers that pay salaries (legal entity,
 * tax numbers, salary account, WeldBooks link) and their pay schedules.
 * Needs payroll:manage.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Banknote, Building2, CalendarClock, Landmark, MoreHorizontal, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPaySchedule, HrPayrollEmployer } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import {
  useDeleteHrPaySchedule,
  useDeleteHrPayrollEmployer,
  useHrPayrollEmployers,
  useHrPayrollSchedules,
  useUpdateHrPayrollEmployer,
} from '@/hooks/queries/use-weldhr-payroll-queries';
import { DashboardPage, EmptyText, FieldGrid, SectionCard, useHrBreadcrumbs } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate } from '../../components/shared';
import { EmployerBankDialog } from '../components/employer-bank-dialog';
import { EmployerDialog } from '../components/employer-dialog';
import { IssueList, PayrollGate } from '../components/payroll-ui';
import { ScheduleDialog } from '../components/schedule-dialog';
import { periodRange } from '../lib/format';

export default function WeldHrPayrollSettingsPage() {
  return (
    <PayrollGate permission="payroll:manage">
      <PayrollSettings />
    </PayrollGate>
  );
}

function PayrollSettings() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.payroll.title'), href: '/weldhr/payroll' }, { label: t('weldhr.payroll.settings.title') });

  const { data: employers, isLoading, error } = useHrPayrollEmployers();
  const { data: schedules, error: schedulesError } = useHrPayrollSchedules();

  const [employerDialog, setEmployerDialog] = useState<{ employer?: HrPayrollEmployer } | null>(null);
  const [bankFor, setBankFor] = useState<HrPayrollEmployer | null>(null);
  const [scheduleDialog, setScheduleDialog] = useState<{ schedule?: HrPaySchedule } | null>(null);
  const [deleteEmployer, setDeleteEmployer] = useState<HrPayrollEmployer | null>(null);
  const [deleteSchedule, setDeleteSchedule] = useState<HrPaySchedule | null>(null);

  const updateEmployer = useUpdateHrPayrollEmployer();
  const removeEmployer = useDeleteHrPayrollEmployer();
  const removeSchedule = useDeleteHrPaySchedule();

  if (isLoading) return <PageLoader fullScreen={false} />;

  const employerList = employers ?? [];

  async function toggleActive(employer: HrPayrollEmployer) {
    try {
      await updateEmployer.mutateAsync({ id: employer.id, isActive: !employer.isActive });
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.payroll.settings.employers.saveFailed')));
    }
  }

  return (
    <DashboardPage title={t('weldhr.payroll.settings.title')}>
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.payroll.settings.loadFailed')) : null} />

      <SectionCard
        title={t('weldhr.payroll.settings.employers.title')}
        action={
          <Button size="sm" onClick={() => setEmployerDialog({})}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.payroll.settings.employers.add')}
          </Button>
        }
      >
        {employerList.length === 0 ? (
          <EmptyText>{t('weldhr.payroll.settings.employers.empty')}</EmptyText>
        ) : (
          <div className="space-y-4">
            {employerList.map((employer) => (
              <EmployerCard
                key={employer.id}
                employer={employer}
                onEdit={() => setEmployerDialog({ employer })}
                onBank={() => setBankFor(employer)}
                onToggleActive={() => void toggleActive(employer)}
                onDelete={() => setDeleteEmployer(employer)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t('weldhr.payroll.settings.schedules.title')}
        action={
          employerList.length > 0 && (
            <Button size="sm" onClick={() => setScheduleDialog({})}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.payroll.settings.schedules.add')}
            </Button>
          )
        }
      >
        <ErrorBanner error={schedulesError ? errorMessage(schedulesError, t('weldhr.payroll.settings.loadFailed')) : null} />
        {employerList.length === 0 && <EmptyText>{t('weldhr.payroll.settings.schedules.needEmployer')}</EmptyText>}
        {employerList.length > 0 && (schedules ?? []).length === 0 && <EmptyText>{t('weldhr.payroll.settings.schedules.empty')}</EmptyText>}
        {(schedules ?? []).length > 0 && (
          <ul className="divide-y">
            {(schedules ?? []).map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                employerName={employerList.find((employer) => employer.id === schedule.employerId)?.name ?? '—'}
                onEdit={() => setScheduleDialog({ schedule })}
                onDelete={() => setDeleteSchedule(schedule)}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      {employerDialog && <EmployerDialog employer={employerDialog.employer} onClose={() => setEmployerDialog(null)} />}
      {bankFor && <EmployerBankDialog employer={bankFor} onClose={() => setBankFor(null)} />}
      {scheduleDialog && <ScheduleDialog schedule={scheduleDialog.schedule} employers={employerList} onClose={() => setScheduleDialog(null)} />}

      <ConfirmDialog
        open={Boolean(deleteEmployer)}
        onOpenChange={(open) => !open && setDeleteEmployer(null)}
        title={t('weldhr.payroll.settings.employers.deleteTitle')}
        description={t('weldhr.payroll.settings.employers.deleteDescription', { name: deleteEmployer?.name ?? '' })}
        variant="destructive"
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        onConfirm={async () => {
          if (!deleteEmployer) return;
          try {
            await removeEmployer.mutateAsync(deleteEmployer.id);
            setDeleteEmployer(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.payroll.settings.employers.deleteFailed')));
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteSchedule)}
        onOpenChange={(open) => !open && setDeleteSchedule(null)}
        title={t('weldhr.payroll.settings.schedules.deleteTitle')}
        description={t('weldhr.payroll.settings.schedules.deleteDescription', { name: deleteSchedule?.name ?? '' })}
        variant="destructive"
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        onConfirm={async () => {
          if (!deleteSchedule) return;
          try {
            await removeSchedule.mutateAsync(deleteSchedule.id);
            setDeleteSchedule(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.payroll.settings.schedules.deleteFailed')));
          }
        }}
      />
    </DashboardPage>
  );
}

function EmployerCard({
  employer,
  onEdit,
  onBank,
  onToggleActive,
  onDelete,
}: Readonly<{ employer: HrPayrollEmployer; onEdit: () => void; onBank: () => void; onToggleActive: () => void; onDelete: () => void }>) {
  const t = useTranslations();
  const isNl = employer.country === 'NL';
  const bank = employer.bank;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {employer.name}
              <Badge variant="outline">{t(`weldhr.payroll.country.${employer.country}`)}</Badge>
              {!employer.isActive && <Badge variant="secondary">{t('weldhr.payroll.settings.employers.inactive')}</Badge>}
            </p>
            <p className="truncate text-sm text-muted-foreground">
              {employer.legalName} · {t('weldhr.payroll.settings.employers.employeeCount', { count: employer.employeeCount })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onBank}>
            <Landmark className="mr-1.5 h-4 w-4" />
            {t('weldhr.payroll.settings.employers.salaryAccount')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="outline" className="h-8 w-8" aria-label={t('weldhr.payroll.settings.employers.menu')}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="mr-2 h-4 w-4" />
                {t('weldhr.common.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onToggleActive}>
                <Power className="mr-2 h-4 w-4" />
                {employer.isActive ? t('weldhr.payroll.settings.employers.deactivate') : t('weldhr.payroll.settings.employers.activate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 className="mr-2 h-4 w-4" />
                {t('weldhr.common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <FieldGrid
        fields={[
          isNl
            ? { label: t('weldhr.payroll.settings.employers.loonheffingennummer'), value: employer.nlSettings.loonheffingennummer }
            : { label: t('weldhr.payroll.settings.employers.ein'), value: employer.usSettings.ein },
          { label: t('weldhr.payroll.settings.employers.accountingEntity'), value: employer.accountingEntityName ?? t('weldhr.payroll.settings.employers.notLinked') },
          {
            label: t('weldhr.payroll.settings.employers.salaryAccount'),
            value: bank ? `${(isNl ? bank.ibanMasked : bank.accountNumberMasked) ?? '—'}${bank.accountHolder ? ` · ${bank.accountHolder}` : ''}` : t('weldhr.payroll.settings.employers.noBank'),
          },
          { label: t('weldhr.payroll.settings.employers.fourEyes'), value: employer.requireSeparateApprover ? t('weldhr.common.yes') : t('weldhr.common.no') },
        ]}
      />

      {employer.issues.length > 0 && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3">
          <p className="text-sm font-medium">{t('weldhr.payroll.settings.employers.issues')}</p>
          <IssueList issues={employer.issues} currency={employer.currency} />
        </div>
      )}
    </div>
  );
}

function ScheduleRow({
  schedule,
  employerName,
  onEdit,
  onDelete,
}: Readonly<{ schedule: HrPaySchedule; employerName: string; onEdit: () => void; onDelete: () => void }>) {
  const t = useTranslations();
  const rule = schedule.payDateRule;
  let ruleText = t('weldhr.payroll.settings.schedules.ruleSummary.last_business_day');
  if (rule.kind === 'day_of_month') ruleText = t('weldhr.payroll.settings.schedules.ruleSummary.day_of_month', { day: rule.day });
  else if (rule.kind === 'offset_after_end') ruleText = t('weldhr.payroll.settings.schedules.ruleSummary.offset_after_end', { days: rule.days });

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-3">
        <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {schedule.name}
            <Badge variant="outline">{t(`weldhr.payroll.frequency.${schedule.frequency}`)}</Badge>
            {!schedule.isActive && <Badge variant="secondary">{t('weldhr.payroll.settings.employers.inactive')}</Badge>}
          </p>
          <p className="text-xs text-muted-foreground">
            {employerName} · {ruleText} · {t('weldhr.payroll.settings.employers.employeeCount', { count: schedule.employeeCount })}
          </p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Banknote className="h-3 w-3" />
            {schedule.nextPeriod
              ? t('weldhr.payroll.settings.schedules.nextPeriod', {
                  period: periodRange(schedule.nextPeriod.start, schedule.nextPeriod.end),
                  payDate: formatDate(schedule.nextPeriod.payDate),
                })
              : t('weldhr.payroll.settings.schedules.noNextPeriod')}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('weldhr.common.edit')} onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('weldhr.common.delete')} onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}
