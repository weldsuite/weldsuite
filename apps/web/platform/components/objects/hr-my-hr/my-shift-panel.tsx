/** My HR → Schedule → one of your shifts: when, the break, planned hours, type of work, client and notes. */

import { Banknote, Briefcase, Building2, CalendarDays, Clock, Coffee, FileText, Timer } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useLoadedMyAttendanceItem } from '@/hooks/queries/use-weldhr-queries';
import { formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { MY_HR_PATHS } from '@/app/weldhr/access';
import { formatMoney, formatWeekdayDate } from '@/app/weldhr/components/shared';
import { plannedHours } from '@/app/weldhr/me/components/schedule-shifts-tab';
import { MY_HR_PANEL_WIDTH, MyHrPanelMenu, MyHrPanelMissing, MyHrPanelTitle, useDetailsTab } from './parts';
import { MY_SHIFT_PANEL_TYPE } from './types';

export function MyShiftPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const shift = useLoadedMyAttendanceItem('shifts', props.id);
  const detailsTab = useDetailsTab();
  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: shift === undefined });

  const breakRange =
    shift?.breakStartsAt && shift.breakEndsAt
      ? formatClockRange(new Date(shift.breakStartsAt), new Date(shift.breakEndsAt), timeFormat)
      : null;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={<MyHrPanelTitle label={shift ? (shift.workType ?? t('weldhr.me.schedule.panel.shift')) : undefined} />}
      actions={shift ? <MyHrPanelMenu listPath={MY_HR_PATHS.schedule} type={MY_SHIFT_PANEL_TYPE} id={shift.id} /> : null}
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {shift === null && <MyHrPanelMissing loaded error={null} onRetry={() => {}} />}

      {shift && (
        <div className="space-y-1 p-4">
          <PanelRow icon={CalendarDays} label={t('weldhr.me.schedule.table.date')} value={formatWeekdayDate(shift.startsAt)} tabular />
          <PanelRow
            icon={Clock}
            label={t('weldhr.me.schedule.table.time')}
            value={formatClockRange(new Date(shift.startsAt), new Date(shift.endsAt), timeFormat)}
            tabular
          />
          <PanelRow icon={Coffee} label={t('weldhr.me.attendance.table.break')} value={breakRange} tabular />
          <PanelRow
            icon={Timer}
            label={t('weldhr.me.schedule.panel.plannedHours')}
            value={t('weldhr.me.schedule.hoursValue', { hours: plannedHours(shift) })}
            tabular
          />
          <PanelRow icon={Briefcase} label={t('weldhr.me.schedule.table.workType')} value={shift.workType ?? null} />
          <PanelRow icon={Building2} label={t('weldhr.me.schedule.table.client')} value={shift.companyName} />
          {shift.hourlyRate != null && shift.currency && (
            <PanelRow
              icon={Banknote}
              label={t('weldhr.me.schedule.panel.hourlyRate')}
              value={t('weldhr.me.schedule.panel.perHour', { amount: formatMoney(shift.hourlyRate, shift.currency) })}
              tabular
            />
          )}
          <PanelRow icon={FileText} label={t('weldhr.me.schedule.panel.notes')} value={shift.notes} />
        </div>
      )}
    </EntityDetailView>
  );
}
