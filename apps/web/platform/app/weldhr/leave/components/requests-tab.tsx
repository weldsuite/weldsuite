/** Leave → Requests: the review queue and full request history. */

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useCancelHrLeaveRequest, useDeleteHrLeaveRequest, useHrLeaveRequests } from '@/hooks/queries/use-weldhr-queries';
import { EmptyState, ErrorBanner, InlineSpinner, StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { LeaveRequestDialog } from './request-dialog';
import { LeaveReviewDialog } from './review-dialog';

export function RequestsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canApprove = can('leave:approve');
  const canUpdate = can('leave:update');
  const canDelete = can('leave:delete');

  const [status, setStatus] = useState('pending');
  const { data: requests, isLoading, error } = useHrLeaveRequests({ status: status === 'all' ? undefined : status });

  const [creating, setCreating] = useState(false);
  const [review, setReview] = useState<{ request: HrLeaveRequest; decision: 'approved' | 'rejected' } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<HrLeaveRequest | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrLeaveRequest | null>(null);

  const cancelRequest = useCancelHrLeaveRequest();
  const deleteRequest = useDeleteHrLeaveRequest();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="w-44 space-y-1">
          <label className="text-xs text-muted-foreground">{t('weldhr.leave.requests.filters.status')}</label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('weldhr.leave.requests.filters.allStatuses')}</SelectItem>
              <SelectItem value="pending">{t('weldhr.status.leave.pending')}</SelectItem>
              <SelectItem value="approved">{t('weldhr.status.leave.approved')}</SelectItem>
              <SelectItem value="rejected">{t('weldhr.status.leave.rejected')}</SelectItem>
              <SelectItem value="cancelled">{t('weldhr.status.leave.cancelled')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t('weldhr.leave.requests.newRequest')}
        </Button>
      </div>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.leave.requests.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !requests || requests.length === 0 ? (
        <EmptyState title={t('weldhr.leave.requests.empty.title')} description={t('weldhr.leave.requests.empty.description')} />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.leave.requests.table.employee')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.type')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.dates')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.days')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.reason')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.status')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.reviewer')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>{request.employeeName}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: request.leaveTypeColor ?? '#94a3b8' }}
                      />
                      {request.leaveTypeName ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    {formatDate(request.startDate)} – {formatDate(request.endDate)}
                  </TableCell>
                  <TableCell>{request.days}</TableCell>
                  <TableCell className="max-w-48 truncate text-muted-foreground">{request.reason ?? '—'}</TableCell>
                  <TableCell>
                    <StatusBadge group="leave" status={request.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{request.reviewedByName ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1.5">
                      {canApprove && request.status === 'pending' && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setReview({ request, decision: 'approved' })}>
                            {t('weldhr.leave.requests.approve')}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setReview({ request, decision: 'rejected' })}>
                            {t('weldhr.leave.requests.reject')}
                          </Button>
                        </>
                      )}
                      {canUpdate && (request.status === 'pending' || request.status === 'approved') && (
                        <Button size="sm" variant="ghost" onClick={() => setCancelTarget(request)}>
                          <X className="mr-1 h-3.5 w-3.5" />
                          {t('weldhr.leave.requests.cancel')}
                        </Button>
                      )}
                      {canDelete && (
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleteTarget(request)}>
                          {t('weldhr.leave.requests.delete')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {creating && <LeaveRequestDialog onClose={() => setCreating(false)} />}
      {review && <LeaveReviewDialog request={review.request} decision={review.decision} onClose={() => setReview(null)} />}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        title={t('weldhr.leave.requests.cancelConfirmTitle')}
        description={t('weldhr.leave.requests.cancelConfirmDescription')}
        onConfirm={async () => {
          if (!cancelTarget) return;
          await cancelRequest.mutateAsync(cancelTarget.id);
          setCancelTarget(null);
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
          await deleteRequest.mutateAsync(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
