/**
 * My HR → Schedule → an open shift: when, the break, type of work, client,
 * who it is for and how many spots are left, your sign-up, and signing up or
 * withdrawing from its menu.
 */

import { useState } from 'react';
import { Briefcase, Building2, CalendarDays, CircleDot, Clock, Coffee, FileText, MessageSquareText, Users, UsersRound } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useMyHrOpenShifts } from '@/hooks/queries/use-weldhr-queries';
import { formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { MY_HR_PATHS } from '@/app/weldhr/access';
import { formatWeekdayDate } from '@/app/weldhr/components/shared';
import {
  OpenShiftMenuItems,
  SignUpBadge,
  SignUpDialog,
  activeRequest,
  useSpotsLabel,
  useWithdrawSignUp,
} from '@/app/weldhr/me/components/open-shifts-card';
import { MY_HR_PANEL_WIDTH, MyHrPanelMenu, MyHrPanelMissing, MyHrPanelTitle, useDetailsTab } from './parts';
import { MY_OPEN_SHIFT_PANEL_TYPE } from './types';

export function MyOpenShiftPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const { data, isLoading, error, refetch } = useMyHrOpenShifts();
  const shift = data?.find((s) => s.id === props.id);
  const withdrawal = useWithdrawSignUp();
  const spotsLabel = useSpotsLabel();
  const [signingUp, setSigningUp] = useState(false);
  const detailsTab = useDetailsTab();
  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: isLoading && !data });

  const request = shift ? activeRequest(shift) : null;
  const breakRange =
    shift?.breakStartsAt && shift.breakEndsAt
      ? formatClockRange(new Date(shift.breakStartsAt), new Date(shift.breakEndsAt), timeFormat)
      : null;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        // The sign-up's state is in its own row: next to the title it would cut the title short.
        <MyHrPanelTitle label={shift ? (shift.workType ?? t('weldhr.me.schedule.panel.openShift')) : undefined} />
      }
      actions={
        shift ? (
          <MyHrPanelMenu listPath={MY_HR_PATHS.schedule} type={MY_OPEN_SHIFT_PANEL_TYPE} id={shift.id}>
            <OpenShiftMenuItems
              shift={shift}
              onSignUp={() => setSigningUp(true)}
              onWithdraw={(id) => void withdrawal.withdraw(id)}
              withdrawing={withdrawal.isPending}
            />
          </MyHrPanelMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {!shift && <MyHrPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

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
          <PanelRow icon={Briefcase} label={t('weldhr.me.schedule.table.workType')} value={shift.workType} />
          <PanelRow icon={Building2} label={t('weldhr.me.schedule.table.client')} value={shift.companyName} />
          <PanelRow icon={UsersRound} label={t('weldhr.me.schedule.panel.department')} value={shift.departmentName} />
          <PanelRow icon={Users} label={t('weldhr.me.schedule.table.spots')} value={spotsLabel(shift.spotsLeft)} tabular />
          <PanelRow
            icon={CircleDot}
            label={t('weldhr.me.schedule.table.signUp')}
            value={request ? request.status : null}
            renderValue={() => <SignUpBadge shift={shift} />}
          />
          {request?.reviewNote && (
            <PanelRow icon={MessageSquareText} label={t('weldhr.me.schedule.panel.reviewNote')} value={request.reviewNote} />
          )}
          <PanelRow icon={FileText} label={t('weldhr.me.schedule.panel.notes')} value={shift.notes} />
        </div>
      )}

      {signingUp && shift && <SignUpDialog shift={shift} onClose={() => setSigningUp(false)} />}
    </EntityDetailView>
  );
}
