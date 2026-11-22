/**
 * My HR → Time off → a leave request of your own: its dates, days, reason and
 * HR's review, with "Cancel request" while it can still be cancelled.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import {
  CalendarCheck,
  CalendarPlus,
  CalendarRange,
  CircleDot,
  FileText,
  Hash,
  MessageSquareText,
  Tag,
  UserCheck,
  X,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useMyHrCancelLeave, useMyHrLeave } from '@/hooks/queries/use-weldhr-queries';
import { StatusBadge, errorMessage, formatDate } from '@/app/weldhr/components/shared';
import { isCancellable } from '@/app/weldhr/me/components/leave-tab';
import { TIME_OFF_PANEL_WIDTH, TimeOffPanelMenu, TimeOffPanelMissing, TimeOffPanelTitle, useDetailsTab } from './parts';
import { MY_LEAVE_REQUEST_PANEL_TYPE } from './types';

export function MyLeaveRequestPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = useMyHrLeave();
  const request = data?.requests.find((r) => r.id === props.id);
  const cancelLeave = useMyHrCancelLeave();
  const [confirming, setConfirming] = useState(false);
  const detailsTab = useDetailsTab();

  const shell = useObjectPanelShell({ ...props, width: TIME_OFF_PANEL_WIDTH, loading: isLoading && !data });

  async function confirmCancel() {
    if (!request) return;
    try {
      await cancelLeave.mutateAsync(request.id);
      toast.success(t('weldhr.me.leave.cancelConfirm.toast'));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.me.leave.cancelConfirm.failed')));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        <TimeOffPanelTitle
          label={request ? (request.leaveTypeName ?? '—') : undefined}
          color={request?.leaveTypeColor ?? null}
          status={request ? <StatusBadge group="leave" status={request.status} /> : null}
        />
      }
      actions={
        request ? (
          <TimeOffPanelMenu type={MY_LEAVE_REQUEST_PANEL_TYPE} id={request.id}>
            {isCancellable(request) ? (
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                <X />
                {t('weldhr.me.leave.cancelConfirm.confirm')}
              </DropdownMenuItem>
            ) : null}
          </TimeOffPanelMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {!request && <TimeOffPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {request && (
        <div className="space-y-1 p-4">
          <PanelRow icon={Tag} label={t('weldhr.me.leave.requests.table.type')} value={request.leaveTypeName} />
          <PanelRow
            icon={CircleDot}
            label={t('weldhr.me.leave.requests.table.status')}
            value={request.status}
            renderValue={() => <StatusBadge group="leave" status={request.status} />}
          />
          <PanelRow
            icon={CalendarRange}
            label={t('weldhr.me.leave.requests.table.dates')}
            value={`${formatDate(request.startDate)} – ${formatDate(request.endDate)}`}
            tabular
          />
          <PanelRow icon={Hash} label={t('weldhr.me.leave.requests.table.days')} value={String(request.days)} tabular />
          <PanelRow icon={FileText} label={t('weldhr.leave.requests.table.reason')} value={request.reason} />
          <PanelRow
            icon={CalendarPlus}
            label={t('weldhr.me.timeOff.panel.requestedOn')}
            value={formatDate(request.createdAt)}
            tabular
          />
          <PanelRow icon={UserCheck} label={t('weldhr.me.timeOff.panel.reviewedBy')} value={request.reviewedByName} />
          <PanelRow
            icon={CalendarCheck}
            label={t('weldhr.me.timeOff.panel.reviewedOn')}
            value={request.reviewedAt ? formatDate(request.reviewedAt) : null}
            tabular
          />
          <PanelRow icon={MessageSquareText} label={t('weldhr.me.timeOff.panel.reviewNote')} value={request.reviewNote} />
        </div>
      )}

      {confirming && request && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(false)}
          title={t('weldhr.me.leave.cancelConfirm.title')}
          description={t('weldhr.me.leave.cancelConfirm.description', {
            type: request.leaveTypeName ?? t('weldhr.me.leave.cancelConfirm.thisLeave'),
            start: formatDate(request.startDate),
            end: formatDate(request.endDate),
          })}
          variant="destructive"
          confirmLabel={t('weldhr.me.leave.cancelConfirm.confirm')}
          cancelLabel={t('weldhr.me.leave.cancelConfirm.keep')}
          onConfirm={confirmCancel}
        />
      )}
    </EntityDetailView>
  );
}
