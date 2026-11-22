/** My HR → Schedule → Hours → one day's clock record: clocked times, break, worked time, status, approval and client. */

import { Banknote, BadgeCheck, Building2, CircleDot, Coffee, FileText, LogIn, LogOut, Timer, TimerOff } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useLoadedMyAttendanceItem } from '@/hooks/queries/use-weldhr-queries';
import { MY_HR_PATHS } from '@/app/weldhr/access';
import { StatusBadge, formatMinutes, formatMoney, formatWeekdayDate, useFormatTime } from '@/app/weldhr/components/shared';
import { RecordStatus } from '@/app/weldhr/me/components/schedule-hours-tab';
import { MY_HR_PANEL_WIDTH, MyHrPanelMenu, MyHrPanelMissing, MyHrPanelTitle, useDetailsTab } from './parts';
import { MY_ATTENDANCE_PANEL_TYPE } from './types';

export function MyAttendancePanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const formatTime = useFormatTime();
  const record = useLoadedMyAttendanceItem('records', props.id);
  const detailsTab = useDetailsTab();
  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: record === undefined });

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        <MyHrPanelTitle
          label={record ? formatWeekdayDate(record.date) : undefined}
          status={record ? <StatusBadge group="attendance" status={record.status} /> : null}
        />
      }
      actions={record ? <MyHrPanelMenu listPath={MY_HR_PATHS.schedule} type={MY_ATTENDANCE_PANEL_TYPE} id={record.id} /> : null}
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {record === null && <MyHrPanelMissing loaded error={null} onRetry={() => {}} />}

      {record && (
        <div className="space-y-1 p-4">
          <PanelRow icon={LogIn} label={t('weldhr.me.attendance.table.clockIn')} value={record.clockIn ? formatTime(record.clockIn) : null} tabular />
          <PanelRow icon={LogOut} label={t('weldhr.me.attendance.table.clockOut')} value={record.clockOut ? formatTime(record.clockOut) : null} tabular />
          <PanelRow
            icon={Coffee}
            label={t('weldhr.me.attendance.table.break')}
            value={record.breakMinutes != null ? formatMinutes(record.breakMinutes) : null}
            tabular
          />
          <PanelRow
            icon={Timer}
            label={t('weldhr.me.attendance.table.worked')}
            value={record.workedMinutes != null ? formatMinutes(record.workedMinutes) : null}
            tabular
          />
          <PanelRow
            icon={CircleDot}
            label={t('weldhr.me.attendance.table.status')}
            value={record.status}
            renderValue={() => <RecordStatus record={record} />}
          />
          {record.lateMinutes != null && record.lateMinutes > 0 && (
            <PanelRow
              icon={TimerOff}
              label={t('weldhr.me.schedule.panel.late')}
              value={t('weldhr.me.attendance.lateBy', { minutes: record.lateMinutes })}
              tabular
            />
          )}
          <PanelRow
            icon={BadgeCheck}
            label={t('weldhr.me.schedule.panel.approval')}
            value={record.approved ? t('weldhr.me.schedule.panel.approved') : t('weldhr.me.attendance.awaitingApproval')}
          />
          <PanelRow icon={Building2} label={t('weldhr.me.attendance.table.client')} value={record.companyName} />
          {record.hourlyRate != null && record.currency && (
            <PanelRow
              icon={Banknote}
              label={t('weldhr.me.schedule.panel.hourlyRate')}
              value={t('weldhr.me.schedule.panel.perHour', { amount: formatMoney(record.hourlyRate, record.currency) })}
              tabular
            />
          )}
          <PanelRow icon={FileText} label={t('weldhr.me.schedule.panel.notes')} value={record.notes ?? null} />
        </div>
      )}
    </EntityDetailView>
  );
}
