/** Leave → Requests: the review queue and full request history, grouped by status. */

import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarRange, Check, Trash2, X } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useCancelHrLeaveRequest, useDeleteHrLeaveRequest, useHrLeaveRequests } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { DayCount, StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { LeaveRequestDialog } from './request-dialog';
import { LeaveReviewDialog } from './review-dialog';

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
const KNOWN_STATUSES = new Set<string>(STATUSES);

/** Distinct non-empty values, sorted, as filter options. */
function optionsOf(values: Array<string | null>): Array<{ value: string; label: string }> {
  return [...new Set(values.filter((v): v is string => !!v))].sort().map((value) => ({ value, label: value }));
}

export function RequestsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canApprove = can('leave:approve');
  const canUpdate = can('leave:update');
  const canDelete = can('leave:delete');

  const { data: requests, isLoading, error } = useHrLeaveRequests({});

  const [creating, setCreating] = useState(false);
  const [review, setReview] = useState<{ request: HrLeaveRequest; decision: 'approved' | 'rejected' } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<HrLeaveRequest | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrLeaveRequest | null>(null);

  const cancelRequest = useCancelHrLeaveRequest();
  const deleteRequest = useDeleteHrLeaveRequest();

  const groups: GroupConfig<HrLeaveRequest>[] = [
    { id: 'pending', label: t('weldhr.leave.requests.groups.pending'), sortOrder: 1, filter: (r) => r.status === 'pending' },
    { id: 'approved', label: t('weldhr.leave.requests.groups.approved'), sortOrder: 2, filter: (r) => r.status === 'approved' },
    { id: 'rejectedCancelled', label: t('weldhr.leave.requests.groups.rejectedCancelled'), sortOrder: 3, filter: (r) => r.status === 'rejected' || r.status === 'cancelled' },
    { id: 'other', label: t('weldhr.leave.requests.groups.other'), sortOrder: 4, filter: (r) => !KNOWN_STATUSES.has(r.status) },
  ];

  const rows = requests ?? [];
  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.leave.requests.filters.status'),
      operators: ['is'],
      options: STATUSES.map((status) => ({ value: status, label: t(`weldhr.status.leave.${status}`) })),
    },
    { field: 'type', label: t('weldhr.leave.requests.table.type'), operators: ['is'], options: optionsOf(rows.map((r) => r.leaveTypeName)) },
    {
      field: 'employee',
      label: t('weldhr.leave.requests.table.employee'),
      operators: ['is'],
      searchable: true,
      options: optionsOf(rows.map((r) => r.employeeName)),
    },
  ];
  const applyFilters = (list: HrLeaveRequest[], active: ActiveFilter[]) =>
    active.reduce((rowsLeft, filter) => {
      if (!filter.value) return rowsLeft;
      if (filter.field === 'status') return rowsLeft.filter((r) => r.status === filter.value);
      if (filter.field === 'type') return rowsLeft.filter((r) => r.leaveTypeName === filter.value);
      if (filter.field === 'employee') return rowsLeft.filter((r) => r.employeeName === filter.value);
      return rowsLeft;
    }, list);

  /**
   * The row's "⋮" menu: approving or rejecting a pending request, cancelling a
   * pending or approved one, and deleting. On one line in the menu instead of
   * buttons that wrapped and made the rows uneven.
   */
  function rowMenu(r: HrLeaveRequest) {
    const review = canApprove && r.status === 'pending';
    const cancel = canUpdate && (r.status === 'pending' || r.status === 'approved');
    if (!review && !cancel && !canDelete) return null;
    return (
      <>
        {review && (
          <>
            <DropdownMenuItem onClick={() => setReview({ request: r, decision: 'approved' })}>
              <Check />
              {t('weldhr.leave.requests.approve')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setReview({ request: r, decision: 'rejected' })}>
              <X />
              {t('weldhr.leave.requests.reject')}
            </DropdownMenuItem>
          </>
        )}
        {cancel && (
          <>
            {review && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => setCancelTarget(r)}>
              <X />
              {t('weldhr.leave.requests.cancel')}
            </DropdownMenuItem>
          </>
        )}
        {canDelete && (
          <>
            {(review || cancel) && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(r)}>
              <Trash2 />
              {t('weldhr.common.delete')}
            </DropdownMenuItem>
          </>
        )}
      </>
    );
  }

  const columns: ColumnDef<HrLeaveRequest>[] = [
    {
      id: 'employee',
      header: t('weldhr.leave.requests.table.employee'),
      width: HR_COL.main,
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{r.employeeName}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground @4xl:hidden">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.leaveTypeColor ?? '#94a3b8' }} />
            <span className="truncate">
              {r.leaveTypeName ?? '—'} · {formatDate(r.startDate)} – {formatDate(r.endDate)} ·{' '}
              <DayCount days={r.days} startDate={r.startDate} endDate={r.endDate} format={(days) => `${days}d`} />
            </span>
          </p>
          <div className="mt-1 @lg:hidden">
            <StatusBadge group="leave" status={r.status} />
          </div>
        </div>
      ),
    },
    {
      id: 'type',
      header: t('weldhr.leave.requests.table.type'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[140px]'),
      render: (r) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.leaveTypeColor ?? '#94a3b8' }} />
          <span className="truncate">{r.leaveTypeName ?? '—'}</span>
        </span>
      ),
    },
    {
      id: 'dates',
      header: t('weldhr.leave.requests.table.dates'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[190px]'),
      render: (r) => (
        <span className="block truncate tabular-nums">
          {formatDate(r.startDate)} – {formatDate(r.endDate)}
        </span>
      ),
    },
    {
      id: 'days',
      header: t('weldhr.leave.requests.table.days'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[72px]'),
      render: (r) => <DayCount days={r.days} startDate={r.startDate} endDate={r.endDate} />,
    },
    {
      id: 'reason',
      header: t('weldhr.leave.requests.table.reason'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[160px]'),
      render: (r) => <span className="block truncate text-muted-foreground">{r.reason ?? '—'}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.leave.requests.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[100px]'),
      render: (r) => <StatusBadge group="leave" status={r.status} />,
    },
    {
      id: 'reviewer',
      header: t('weldhr.leave.requests.table.reviewer'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[130px]'),
      render: (r) => <span className="block truncate text-muted-foreground">{r.reviewedByName ?? '—'}</span>,
    },
  ];

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrLeaveRequest>
          items={rows}
          isLoading={isLoading}
          error={error}
          columns={columns}
          groups={groups}
          filters={filters}
          applyFilters={applyFilters}
          searchFields={['employeeName', 'leaveTypeName', 'reason']}
          searchPlaceholder={t('weldhr.leave.requests.searchPlaceholder')}
          rowMenu={rowMenu}
          createButton={{ label: t('weldhr.leave.requests.newRequest'), onClick: () => setCreating(true) }}
          emptyState={{
            icon: emptyIcon(CalendarRange),
            title: t('weldhr.leave.requests.empty.title'),
            description: t('weldhr.leave.requests.empty.description'),
          }}
        />
      </HrListContainer>

      {creating && <LeaveRequestDialog onClose={() => setCreating(false)} />}
      {review && <LeaveReviewDialog request={review.request} decision={review.decision} onClose={() => setReview(null)} />}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        title={t('weldhr.leave.requests.cancelConfirmTitle')}
        description={t('weldhr.leave.requests.cancelConfirmDescription')}
        // "Cancel" would be ambiguous here: it is the request that gets cancelled.
        confirmLabel={t('weldhr.leave.requests.cancel')}
        cancelLabel={t('weldhr.leave.requests.keepRequest')}
        onConfirm={async () => {
          if (!cancelTarget) return;
          try {
            await cancelRequest.mutateAsync(cancelTarget.id);
            setCancelTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.leave.requests.cancelFailed')));
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.leave.requests.deleteConfirmTitle')}
        description={t('weldhr.leave.requests.deleteConfirmDescription')}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteRequest.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.leave.requests.deleteFailed')));
          }
        }}
      />
    </>
  );
}
