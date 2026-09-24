/** Leave → Requests: the review queue and full request history, grouped by status. */

import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarRange, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { useCancelHrLeaveRequest, useDeleteHrLeaveRequest, useHrLeaveRequests } from '@/hooks/queries/use-weldhr-queries';
import { emptyIcon } from '../../components/page-kit';
import { StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { LeaveRequestDialog } from './request-dialog';
import { LeaveReviewDialog } from './review-dialog';

const KNOWN_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

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
    { id: 'other', label: t('weldhr.leave.requests.groups.other'), sortOrder: 4, filter: (r) => !KNOWN_STATUSES.includes(r.status) },
  ];

  const columns: ColumnDef<HrLeaveRequest>[] = [
    {
      id: 'employee',
      header: t('weldhr.leave.requests.table.employee'),
      width: 'flex-1',
      render: (r) => <span className="truncate font-medium">{r.employeeName}</span>,
    },
    {
      id: 'type',
      header: t('weldhr.leave.requests.table.type'),
      width: 'w-[150px]',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 truncate">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.leaveTypeColor ?? '#94a3b8' }} />
          <span className="truncate">{r.leaveTypeName ?? '—'}</span>
        </span>
      ),
    },
    {
      id: 'dates',
      header: t('weldhr.leave.requests.table.dates'),
      width: 'w-[190px]',
      render: (r) => (
        <span className="text-muted-foreground">
          {formatDate(r.startDate)} – {formatDate(r.endDate)}
        </span>
      ),
    },
    {
      id: 'days',
      header: t('weldhr.leave.requests.table.days'),
      width: 'w-[70px]',
      render: (r) => <span>{r.days}</span>,
    },
    {
      id: 'reason',
      header: t('weldhr.leave.requests.table.reason'),
      width: 'w-[180px]',
      render: (r) => <span className="truncate text-muted-foreground">{r.reason ?? '—'}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.leave.requests.table.status'),
      width: 'w-[110px]',
      render: (r) => <StatusBadge group="leave" status={r.status} />,
    },
    {
      id: 'reviewer',
      header: t('weldhr.leave.requests.table.reviewer'),
      width: 'w-[130px]',
      render: (r) => <span className="truncate text-muted-foreground">{r.reviewedByName ?? '—'}</span>,
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[210px]',
      render: (r) => (
        <div className="flex justify-end gap-1.5">
          {canApprove && r.status === 'pending' && (
            <>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setReview({ request: r, decision: 'approved' }); }}>
                {t('weldhr.leave.requests.approve')}
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setReview({ request: r, decision: 'rejected' }); }}>
                {t('weldhr.leave.requests.reject')}
              </Button>
            </>
          )}
          {canUpdate && (r.status === 'pending' || r.status === 'approved') && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setCancelTarget(r); }}>
              <X className="mr-1 h-3.5 w-3.5" />
              {t('weldhr.leave.requests.cancel')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PanelEntityList<HrLeaveRequest>
        items={requests ?? []}
        isLoading={isLoading}
        error={error}
        columns={columns}
        groups={groups}
        filters={[]}
        onDelete={canDelete ? (r) => setDeleteTarget(r) : undefined}
        createButton={{ label: t('weldhr.leave.requests.newRequest'), onClick: () => setCreating(true) }}
        emptyState={{
          icon: emptyIcon(CalendarRange),
          title: t('weldhr.leave.requests.empty.title'),
          description: t('weldhr.leave.requests.empty.description'),
        }}
      />

      {creating && <LeaveRequestDialog onClose={() => setCreating(false)} />}
      {review && <LeaveReviewDialog request={review.request} decision={review.decision} onClose={() => setReview(null)} />}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        title={t('weldhr.leave.requests.cancelConfirmTitle')}
        description={t('weldhr.leave.requests.cancelConfirmDescription')}
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
