/** Employee detail — leave tab: this year's balances, request history, and a new request. */

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrEmployee, useHrLeaveBalances, useHrLeaveRequests } from '@/hooks/queries/use-weldhr-queries';
import { LeaveRequestDialog } from '../../leave/components/request-dialog';
import { LeaveReviewDialog } from '../../leave/components/review-dialog';
import { EmptyState, ErrorBanner, InlineSpinner, StatusBadge, errorMessage, formatDate, todayIso } from '../shared';

const CURRENT_YEAR = Number(todayIso().slice(0, 4));

export function EmployeeLeaveTab({ employeeId }: { employeeId: string }) {
  const t = useTranslations();
  const { can } = usePermissions();
  const canApprove = can('leave:approve');

  const { data: employee } = useHrEmployee(employeeId);
  const { data: balances, isLoading: balancesLoading, error: balancesError } = useHrLeaveBalances(employeeId, CURRENT_YEAR);
  const { data: requests, isLoading: requestsLoading, error: requestsError } = useHrLeaveRequests({ employeeId });

  const [creating, setCreating] = useState(false);
  const [review, setReview] = useState<{ request: HrLeaveRequest; decision: 'approved' | 'rejected' } | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t('weldhr.leave.tabs.balances')}</p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t('weldhr.leave.requests.newRequest')}
        </Button>
      </div>

      <ErrorBanner error={balancesError ? errorMessage(balancesError, t('weldhr.leave.balances.loadFailed')) : null} />

      {balancesLoading ? (
        <InlineSpinner />
      ) : !balances || balances.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('weldhr.leave.balances.empty')}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {balances.map((balance) => (
            <Card key={balance.leaveTypeId} className="p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: balance.color ?? '#94a3b8' }} />
                {balance.name}
              </div>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {balance.remaining ?? t('weldhr.leave.balances.unlimited')}
              </p>
              <p className="text-xs text-muted-foreground">
                {balance.used} {t('weldhr.leave.balances.table.used').toLowerCase()}
                {balance.pending > 0 ? ` · ${balance.pending} ${t('weldhr.leave.balances.table.pending').toLowerCase()}` : ''}
              </p>
            </Card>
          ))}
        </div>
      )}

      <p className="pt-2 text-sm font-medium">{t('weldhr.leave.balances.history')}</p>
      <ErrorBanner error={requestsError ? errorMessage(requestsError, t('weldhr.leave.requests.loadFailed')) : null} />

      {requestsLoading ? (
        <InlineSpinner />
      ) : !requests || requests.length === 0 ? (
        <EmptyState title={t('weldhr.leave.balances.noHistory')} />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.leave.requests.table.type')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.dates')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.days')}</TableHead>
                <TableHead>{t('weldhr.leave.requests.table.status')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>{request.leaveTypeName ?? '—'}</TableCell>
                  <TableCell>
                    {formatDate(request.startDate)} – {formatDate(request.endDate)}
                  </TableCell>
                  <TableCell>{request.days}</TableCell>
                  <TableCell>
                    <StatusBadge group="leave" status={request.status} />
                  </TableCell>
                  <TableCell>
                    {canApprove && request.status === 'pending' && (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => setReview({ request, decision: 'approved' })}>
                          {t('weldhr.leave.requests.approve')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setReview({ request, decision: 'rejected' })}>
                          {t('weldhr.leave.requests.reject')}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {creating && (
        <LeaveRequestDialog fixedEmployeeId={employeeId} fixedEmployeeLabel={employee?.displayName ?? null} onClose={() => setCreating(false)} />
      )}
      {review && <LeaveReviewDialog request={review.request} decision={review.decision} onClose={() => setReview(null)} />}
    </div>
  );
}
