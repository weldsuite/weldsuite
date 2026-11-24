/**
 * WeldHR shift request object panel: a shift an employee asked to work (their
 * own proposal, or a sign-up for a posted open shift) with its day, hours,
 * note and review, and Approve and Decline in its menu while it waits.
 *
 * There is no endpoint for one request, so the panel reads it from the request
 * lists already loaded (`useLoadedHrShiftRequest`); it opens from a row of
 * Attendance → Requests.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Briefcase,
  CalendarDays,
  Check,
  CircleDot,
  Clock,
  EllipsisVertical,
  FileText,
  Inbox,
  LayoutGrid,
  MessageSquare,
  Send,
  Timer,
  User,
  UserCheck,
  X,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import type { HrShiftRequest } from '@weldsuite/app-api-client/domains/weldhr';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { HR_EMPLOYEE_PANEL_TYPE } from '@/components/objects/hr-employee/hr-employee-tabs';
import { PanelRow, RecordLoadFailed } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useLoadedHrShiftRequest, useReviewHrShiftRequest } from '@/hooks/queries/use-weldhr-queries';
import { formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { StatusBadge, errorMessage, formatDateTime, formatMinutes, formatWeekdayDate } from '@/app/weldhr/components/shared';
import { ShiftRequestDeclineDialog } from '@/app/weldhr/attendance/components/shift-request-decline-dialog';

const HR_SHIFT_REQUEST_PANEL_WIDTH = 400;

function lengthMinutes(request: HrShiftRequest): number {
  return Math.max(0, Math.round((new Date(request.endsAt).getTime() - new Date(request.startsAt).getTime()) / 60_000));
}

export function HrShiftRequestPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const { can } = usePermissions();
  const { open } = useObjectPanel();
  const request = useLoadedHrShiftRequest(props.id);
  const reviewRequest = useReviewHrShiftRequest();
  const [declining, setDeclining] = useState(false);

  // Approving creates a shift, so it takes the same permission as adding one on the schedule.
  const canReview = can('attendance:create') && request?.status === 'pending';
  const shell = useObjectPanelShell({ ...props, width: HR_SHIFT_REQUEST_PANEL_WIDTH, loading: request === undefined });
  const detailsTab = { id: 'overview', label: t('sweep.entities.detailsTab'), icon: LayoutGrid };

  const timeRange = request ? formatClockRange(new Date(request.startsAt), new Date(request.endsAt), timeFormat) : '';

  async function review(decision: 'approved' | 'rejected', note: string | null = null): Promise<boolean> {
    if (!request) return false;
    try {
      await reviewRequest.mutateAsync({ id: request.id, decision, note });
      if (decision === 'approved') toast.success(t('weldhr.attendance.requests.approvedToast'));
      return true;
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.attendance.requests.reviewFailed')));
      return false;
    }
  }

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        request ? (
          <span className="relative top-px truncate text-[15px] font-medium text-foreground">
            {request.workType ?? t('weldhr.attendance.requests.panel.title')}
          </span>
        ) : (
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
        )
      }
      actions={
        canReview ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
                aria-label={t('sweep.entities.moreActions')}
              >
                <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={reviewRequest.isPending} onClick={() => void review('approved')}>
                <Check />
                {t('weldhr.attendance.requests.approve')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={reviewRequest.isPending} onClick={() => setDeclining(true)}>
                <X />
                {t('weldhr.attendance.requests.decline')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {request === null && (
        <RecordLoadFailed notFound message={t('weldhr.attendance.requests.panel.notFound')} retryLabel="" onRetry={() => {}} />
      )}

      {request && (
        <div className="space-y-1 p-4">
          <PanelRow
            icon={User}
            label={t('weldhr.attendance.requests.table.employee')}
            value={request.employeeName}
            renderValue={(name) => (
              <button
                type="button"
                className="max-w-full truncate text-left text-primary hover:underline"
                onClick={() => open({ type: HR_EMPLOYEE_PANEL_TYPE, id: request.employeeId, stack: true })}
              >
                {name}
              </button>
            )}
          />
          <PanelRow
            icon={Inbox}
            label={t('weldhr.attendance.requests.panel.kind')}
            value={
              request.openShiftId
                ? t('weldhr.attendance.requests.panel.kindOpenShift')
                : t('weldhr.attendance.requests.panel.kindProposed')
            }
          />
          <PanelRow icon={CalendarDays} label={t('weldhr.attendance.requests.table.day')} value={formatWeekdayDate(request.startsAt)} tabular />
          <PanelRow icon={Clock} label={t('weldhr.attendance.requests.table.time')} value={timeRange} tabular />
          <PanelRow icon={Timer} label={t('weldhr.attendance.requests.table.length')} value={formatMinutes(lengthMinutes(request))} tabular />
          <PanelRow icon={Briefcase} label={t('weldhr.attendance.requests.table.workType')} value={request.workType} />
          <PanelRow icon={FileText} label={t('weldhr.attendance.requests.table.note')} value={request.note} />
          <PanelRow icon={Send} label={t('weldhr.attendance.requests.table.requested')} value={formatDateTime(request.createdAt)} tabular />
          <PanelRow
            icon={CircleDot}
            label={t('weldhr.attendance.requests.table.status')}
            value={request.status}
            renderValue={() => <StatusBadge group="shiftRequest" status={request.status} />}
          />
          {request.status !== 'pending' && (
            <>
              <PanelRow icon={UserCheck} label={t('weldhr.attendance.requests.table.reviewer')} value={request.reviewedByName} />
              <PanelRow icon={MessageSquare} label={t('weldhr.attendance.requests.panel.reviewNote')} value={request.reviewNote} />
            </>
          )}
        </div>
      )}

      {declining && request && (
        <ShiftRequestDeclineDialog
          request={request}
          summary={`${formatWeekdayDate(request.startsAt)} · ${timeRange}`}
          onConfirm={(note) => review('rejected', note)}
          onClose={() => setDeclining(false)}
        />
      )}
    </EntityDetailView>
  );
}
