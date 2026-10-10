/** Employee Payroll tab — the payroll profile: employer, schedule, status and the country-specific details. */

import { Pencil } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { useHrPayrollSchedules } from '@/hooks/queries/use-weldhr-payroll-queries';
import { FieldGrid, SectionCard } from '../../components/page-kit';
import { formatDate } from '../../components/shared';
import { IssueList } from '../components/payroll-ui';

function yesNo(t: (key: string) => string, value: boolean | null | undefined, defaultLabel?: string): string {
  if (value === null || value === undefined) return defaultLabel ?? '—';
  return value ? t('weldhr.common.yes') : t('weldhr.common.no');
}

export function ProfileCard({ detail, canEdit, onEdit }: Readonly<{ detail: HrPayrollEmployeeDetail; canEdit: boolean; onEdit: () => void }>) {
  const t = useTranslations();
  const { profile, employer } = detail;
  const { data: schedules } = useHrPayrollSchedules({ employerId: profile?.employerId }, { enabled: Boolean(profile) });
  if (!profile || !employer) return null;

  const scheduleName = schedules?.find((schedule) => schedule.id === profile.payScheduleId)?.name ?? null;
  const common = [
    { label: t('weldhr.payroll.common.employer'), value: `${employer.name} (${t(`weldhr.payroll.country.${employer.country}`)})` },
    { label: t('weldhr.payroll.common.schedule'), value: scheduleName ?? t('weldhr.payroll.employee.profile.noSchedule') },
    { label: t('weldhr.payroll.common.status'), value: <Badge variant={profile.status === 'active' ? 'default' : 'secondary'}>{t(`weldhr.payroll.employee.profile.statuses.${profile.status}`)}</Badge> },
    { label: t('weldhr.payroll.employee.profile.startDate'), value: formatDate(profile.startDate) },
    { label: t('weldhr.payroll.employee.profile.endDate'), value: formatDate(profile.endDate) },
  ];

  const nl = profile.nl;
  const us = profile.us;
  const country =
    employer.country === 'NL'
      ? [
          { label: t('weldhr.payroll.employee.profile.nl.writtenContract'), value: yesNo(t, nl.writtenContract) },
          { label: t('weldhr.payroll.employee.profile.nl.indefiniteContract'), value: yesNo(t, nl.indefiniteContract) },
          { label: t('weldhr.payroll.employee.profile.nl.onCall'), value: yesNo(t, nl.onCall) },
          { label: t('weldhr.payroll.employee.profile.nl.isDga'), value: yesNo(t, nl.isDga) },
          { label: t('weldhr.payroll.employee.profile.nl.contractHours'), value: nl.contractHoursPerWeek === null || nl.contractHoursPerWeek === undefined ? null : String(nl.contractHoursPerWeek) },
          {
            label: t('weldhr.payroll.employee.profile.nl.expatRuling'),
            value: nl.expatRuling ? t('weldhr.payroll.employee.profile.nl.rulingSummary', { percent: nl.expatRuling.percent, from: formatDate(nl.expatRuling.from) }) : t('weldhr.common.no'),
          },
          { label: t('weldhr.payroll.employee.profile.nl.insuredWw'), value: yesNo(t, nl.insuredWw, t('weldhr.payroll.employee.profile.nl.insuranceAuto')) },
          { label: t('weldhr.payroll.employee.profile.nl.insuredZw'), value: yesNo(t, nl.insuredZw, t('weldhr.payroll.employee.profile.nl.insuranceAuto')) },
          { label: t('weldhr.payroll.employee.profile.nl.insuredWao'), value: yesNo(t, nl.insuredWao, t('weldhr.payroll.employee.profile.nl.insuranceAuto')) },
          { label: t('weldhr.payroll.employee.profile.nl.initials'), value: nl.initials },
          { label: t('weldhr.payroll.employee.profile.nl.surnamePrefix'), value: nl.surnamePrefix },
          { label: t('weldhr.payroll.employee.profile.nl.nationality'), value: nl.nationality },
        ]
      : [
          { label: t('weldhr.payroll.employee.profile.us.workState'), value: us.workState },
          { label: t('weldhr.payroll.employee.profile.us.residenceState'), value: us.residenceState ?? t('weldhr.payroll.employee.profile.us.sameAsWork') },
          { label: t('weldhr.payroll.employee.profile.us.flsaStatus'), value: us.flsaStatus ? t(`weldhr.payroll.employee.profile.us.${us.flsaStatus}`) : null },
          { label: t('weldhr.payroll.employee.profile.us.statutoryEmployee'), value: yesNo(t, us.statutoryEmployee) },
          { label: t('weldhr.payroll.employee.profile.us.retirementPlan'), value: yesNo(t, us.retirementPlan) },
          { label: t('weldhr.payroll.employee.profile.us.exemptFica'), value: yesNo(t, us.exemptFica) },
          { label: t('weldhr.payroll.employee.profile.us.exemptFuta'), value: yesNo(t, us.exemptFuta) },
        ];

  return (
    <SectionCard
      title={t('weldhr.payroll.employee.profile.title')}
      action={
        canEdit && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="mr-1.5 h-4 w-4" />
            {t('weldhr.common.edit')}
          </Button>
        )
      }
    >
      <div className="space-y-5">
        {detail.issues.length > 0 && (
          <div className="space-y-2 rounded-md bg-muted/40 p-3">
            <p className="text-sm font-medium">{t('weldhr.payroll.employee.profile.issues')}</p>
            <IssueList issues={detail.issues} currency={employer.currency} />
          </div>
        )}
        <FieldGrid fields={common} />
        <div className="border-t pt-4">
          <FieldGrid fields={country} />
        </div>
      </div>
    </SectionCard>
  );
}
