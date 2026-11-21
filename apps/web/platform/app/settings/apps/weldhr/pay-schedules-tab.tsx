/**
 * Settings → Apps → WeldHR → Pay schedules: the pay schedules of each
 * employer. The employers themselves (legal entity, tax numbers, salary
 * account, WeldBooks link) are managed on Settings → Entities. The page shows
 * this tab only with the weldhr-payroll flag and payroll:manage.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Banknote, CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPaySchedule } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useDeleteHrPaySchedule, useHrPayrollEmployers, useHrPayrollSchedules } from '@/hooks/queries/use-weldhr-payroll-queries';
import { errorMessage, formatDate } from '@/app/weldhr/components/shared';
import { ScheduleDialog } from '@/app/weldhr/payroll/components/schedule-dialog';
import { periodRange } from '@/app/weldhr/payroll/lib/format';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';

export function PaySchedulesTab() {
  const t = useTranslations();

  const { data: employers, isLoading, error } = useHrPayrollEmployers();
  const { data: schedules, error: schedulesError } = useHrPayrollSchedules();

  const [scheduleDialog, setScheduleDialog] = useState<{ schedule?: HrPaySchedule } | null>(null);
  const [deleteSchedule, setDeleteSchedule] = useState<HrPaySchedule | null>(null);

  const removeSchedule = useDeleteHrPaySchedule();

  if (isLoading) return <PageLoader fullScreen={false} />;

  const employerList = employers ?? [];

  return (
    <div className="space-y-6">
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.payroll.settings.loadFailed')) : null} />

      <SectionCard
        title={t('weldhr.payroll.settings.employers.title')}
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/settings/entities" search={{ tab: 'employers' }}>
              {t('weldhr.payroll.settings.employers.manage')}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
        }
      >
        <EmptyText>{t('weldhr.payroll.settings.employers.movedNotice')}</EmptyText>
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

      {scheduleDialog && <ScheduleDialog schedule={scheduleDialog.schedule} employers={employerList} onClose={() => setScheduleDialog(null)} />}

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
