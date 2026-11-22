/**
 * My HR → Time off → the balance of one leave type: its allowance, use and
 * what is left, and your requests of that type (each opens its own panel).
 */

import { useState } from 'react';
import {
  Banknote,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Hourglass,
  Scale,
  ShieldAlert,
  Tag,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
  type ObjectPanelTabDescriptor,
} from '@/components/object-panel';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { ActivityIllustration, TabEmptyState, tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useMyHrLeave } from '@/hooks/queries/use-weldhr-queries';
import { StatusBadge, formatDate } from '@/app/weldhr/components/shared';
import { TIME_OFF_PANEL_WIDTH, TimeOffPanelMenu, TimeOffPanelMissing, TimeOffPanelTitle, useDetailsTab } from './parts';
import { MY_LEAVE_BALANCE_PANEL_TYPE, MY_LEAVE_REQUEST_PANEL_TYPE } from './types';

type TabId = 'overview' | 'requests';

export function MyLeaveBalancePanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { open } = useObjectPanel();
  const { data, isLoading, error, refetch } = useMyHrLeave();
  // A balance is keyed by its leave type.
  const balance = data?.balances.find((b) => b.leaveTypeId === props.id);
  const requests = (data?.requests ?? []).filter((r) => r.leaveTypeId === props.id);
  const [activeTab, setActiveTab] = useState<TabId>(props.initialTab === 'requests' ? 'requests' : 'overview');
  const detailsTab = useDetailsTab();

  const shell = useObjectPanelShell({ ...props, width: TIME_OFF_PANEL_WIDTH, loading: isLoading && !data });

  const tabs: ObjectPanelTabDescriptor[] = [
    detailsTab,
    {
      id: 'requests',
      label: t('weldhr.me.timeOff.panel.requests'),
      icon: CalendarRange,
      count: requests.length || undefined,
    },
  ];
  const days = (value: number | null) => (value === null ? t('weldhr.me.leave.balances.unlimited') : String(value));

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={<TimeOffPanelTitle label={balance?.name} color={balance?.color ?? null} />}
      actions={balance ? <TimeOffPanelMenu type={MY_LEAVE_BALANCE_PANEL_TYPE} id={balance.leaveTypeId} /> : null}
      tabs={<ObjectPanelTabs tabs={tabs} activeTab={activeTab} onChange={(id) => setActiveTab(id as TabId)} />}
    >
      {!balance && <TimeOffPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {balance && activeTab === 'overview' && (
        <div className="space-y-1 p-4">
          <PanelRow icon={Tag} label={t('weldhr.me.timeOff.balances.type')} value={balance.name} />
          <PanelRow
            icon={Banknote}
            label={t('weldhr.me.timeOff.filters.pay')}
            value={t(balance.isPaid ? 'weldhr.me.timeOff.filters.paid' : 'weldhr.me.timeOff.filters.unpaid')}
          />
          <PanelRow icon={Scale} label={t('weldhr.me.timeOff.balances.allowance')} value={days(balance.allowance)} tabular />
          {balance.prorated && (
            <PanelRow
              icon={CalendarDays}
              label={t('weldhr.me.timeOff.panel.fullAllowance')}
              value={days(balance.fullAllowance)}
              tabular
            />
          )}
          <PanelRow icon={CalendarCheck} label={t('weldhr.me.timeOff.balances.used')} value={String(balance.used)} tabular />
          <PanelRow icon={Hourglass} label={t('weldhr.me.timeOff.balances.pending')} value={String(balance.pending)} tabular />
          <PanelRow
            icon={CalendarClock}
            label={t('weldhr.me.timeOff.balances.remaining')}
            value={days(balance.remaining)}
            tabular
          />
          {balance.allowance !== null && (
            <PanelRow
              icon={ShieldAlert}
              label={t('weldhr.me.timeOff.panel.overAllowance')}
              value={t(`weldhr.me.timeOff.panel.overAllowanceValues.${balance.overAllowance}`)}
            />
          )}
        </div>
      )}

      {balance && activeTab === 'requests' && requests.length === 0 && (
        <TabEmptyState
          illustration={<ActivityIllustration />}
          title={t('weldhr.me.timeOff.panel.noRequests.title')}
          description={t('weldhr.me.timeOff.panel.noRequests.description')}
        />
      )}

      {balance && activeTab === 'requests' && requests.length > 0 && (
        <TabListScope>
          {requests.map((request) => (
            <TabListRow
              key={request.id}
              label={`${formatDate(request.startDate)} – ${formatDate(request.endDate)}`}
              onOpen={() => open({ type: MY_LEAVE_REQUEST_PANEL_TYPE, id: request.id, stack: true })}
              // Tighter than a page row, so the dates fit the side panel.
              className="gap-3"
            >
              <span className="min-w-0 flex-1 truncate text-sm tabular-nums">
                {formatDate(request.startDate)} – {formatDate(request.endDate)}
              </span>
              <span className="w-6 flex-shrink-0 text-right text-sm tabular-nums">{request.days}</span>
              <span className="flex w-[76px] flex-shrink-0 justify-end">
                <StatusBadge group="leave" status={request.status} />
              </span>
            </TabListRow>
          ))}
        </TabListScope>
      )}
    </EntityDetailView>
  );
}
