/** My HR → Time off → Leave: your leave requests as a list grouped by status, requesting leave, and cancelling a request. */

import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarRange, X } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useObjectPanel } from '@/components/object-panel';
import { MY_LEAVE_REQUEST_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import { useMyHrCancelLeave, useMyHrLeave } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { StatusBadge, errorMessage, formatDate, todayIso } from '../../components/shared';
import { LeaveRequestDialog } from './leave-request-dialog';
import { ColorDot } from './shared';

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
const KNOWN_STATUSES = new Set<string>(STATUSES);

/** Mirrors the server: pending requests, and approved ones that have not started yet. */
export function isCancellable(request: HrSelfLeaveRequest): boolean {
  return request.status === 'pending' || (request.status === 'approved' && request.startDate > todayIso());
}

export function MyLeaveList({ canRequest }: Readonly<{ canRequest: boolean }>) {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrLeave();
  const cancelLeave = useMyHrCancelLeave();
  const { open: openPanel } = useObjectPanel();
  const [creating, setCreating] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<HrSelfLeaveRequest | null>(null);

  async function confirmCancel(request: HrSelfLeaveRequest) {
    try {
      await cancelLeave.mutateAsync(request.id);
      toast.success(t('weldhr.me.leave.cancelConfirm.toast'));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.me.leave.cancelConfirm.failed')));
    } finally {
      setCancelTarget(null);
    }
  }

  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.me.timeOff.filters.status'),
      operators: ['is'],
      options: STATUSES.map((status) => ({ value: status, label: t(`weldhr.status.leave.${status}`) })),
    },
    {
      field: 'type',
      label: t('weldhr.me.timeOff.filters.type'),
      operators: ['is'],
      options: (data?.types ?? []).map((type) => ({ value: type.id, label: type.name })),
    },
  ];

  const applyFilters = (rows: HrSelfLeaveRequest[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'status') return list.filter((r) => r.status === filter.value);
      if (filter.field === 'type') return list.filter((r) => r.leaveTypeId === filter.value);
      return list;
    }, rows);

  // The same groups as the back office's Leave → Requests.
  const groups: GroupConfig<HrSelfLeaveRequest>[] = [
    { id: 'pending', label: t('weldhr.leave.requests.groups.pending'), sortOrder: 1, filter: (r) => r.status === 'pending' },
    { id: 'approved', label: t('weldhr.leave.requests.groups.approved'), sortOrder: 2, filter: (r) => r.status === 'approved' },
    { id: 'rejectedCancelled', label: t('weldhr.leave.requests.groups.rejectedCancelled'), sortOrder: 3, filter: (r) => r.status === 'rejected' || r.status === 'cancelled' },
    { id: 'other', label: t('weldhr.leave.requests.groups.other'), sortOrder: 4, filter: (r) => !KNOWN_STATUSES.has(r.status) },
  ];

  const columns: ColumnDef<HrSelfLeaveRequest>[] = [
    {
      id: 'type',
      header: t('weldhr.me.leave.requests.table.type'),
      width: HR_COL.main,
      render: (r) => (
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-1.5">
            <ColorDot color={r.leaveTypeColor} />
            <span className="truncate font-medium">{r.leaveTypeName ?? '—'}</span>
          </p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground @lg:hidden">
            {formatDate(r.startDate)} – {formatDate(r.endDate)} · {r.days}d
          </p>
          <div className="mt-1 @lg:hidden">
            <StatusBadge group="leave" status={r.status} />
          </div>
        </div>
      ),
    },
    {
      id: 'dates',
      header: t('weldhr.me.leave.requests.table.dates'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[190px]'),
      render: (r) => (
        <span className="block truncate tabular-nums">
          {formatDate(r.startDate)} – {formatDate(r.endDate)}
        </span>
      ),
    },
    {
      id: 'days',
      header: t('weldhr.me.leave.requests.table.days'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[60px]'),
      render: (r) => <span className="tabular-nums">{r.days}</span>,
    },
    {
      id: 'note',
      header: t('weldhr.leave.requests.table.reason'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[200px]'),
      render: (r) => (
        <span className="block truncate text-muted-foreground">
          {r.reviewNote ? t('weldhr.me.leave.requests.reviewNote', { note: r.reviewNote }) : (r.reason ?? '—')}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('weldhr.me.leave.requests.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[100px]'),
      render: (r) => <StatusBadge group="leave" status={r.status} />,
    },
  ];

  const requestButton = canRequest ? { label: t('weldhr.me.leave.requestLeave'), onClick: () => setCreating(true) } : undefined;

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrSelfLeaveRequest>
          items={data?.requests ?? []}
          isLoading={isLoading}
          error={data ? null : (error as Error | null)}
          columns={columns}
          onRowClick={(r) => openPanel({ type: MY_LEAVE_REQUEST_PANEL_TYPE, id: r.id })}
          objectPanel={{ type: MY_LEAVE_REQUEST_PANEL_TYPE }}
          // The row's "⋮" menu (on hover): cancelling, while the request can still be cancelled.
          rowMenu={(r) =>
            isCancellable(r) ? (
              <DropdownMenuItem variant="destructive" onClick={() => setCancelTarget(r)}>
                <X />
                {t('weldhr.me.leave.cancelConfirm.confirm')}
              </DropdownMenuItem>
            ) : null
          }
          groups={groups}
          filters={filters}
          applyFilters={applyFilters}
          searchFields={['leaveTypeName', 'reason', 'reviewNote']}
          searchPlaceholder={t('weldhr.me.timeOff.search.leave')}
          createButton={requestButton}
          emptyState={{
            icon: emptyIcon(CalendarRange),
            title: t('weldhr.me.leave.requests.empty'),
            // Without the button, say why: the workspace turned requests off.
            description: canRequest ? t('weldhr.me.timeOff.empty.leave') : t('weldhr.me.leave.requestsOff'),
            action: requestButton,
          }}
        />
      </HrListContainer>

      {creating && data && <LeaveRequestDialog types={data.types} onClose={() => setCreating(false)} />}

      {cancelTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setCancelTarget(null)}
          title={t('weldhr.me.leave.cancelConfirm.title')}
          description={t('weldhr.me.leave.cancelConfirm.description', {
            type: cancelTarget.leaveTypeName ?? t('weldhr.me.leave.cancelConfirm.thisLeave'),
            start: formatDate(cancelTarget.startDate),
            end: formatDate(cancelTarget.endDate),
          })}
          variant="destructive"
          confirmLabel={t('weldhr.me.leave.cancelConfirm.confirm')}
          cancelLabel={t('weldhr.me.leave.cancelConfirm.keep')}
          onConfirm={() => confirmCancel(cancelTarget)}
        />
      )}
    </>
  );
}
