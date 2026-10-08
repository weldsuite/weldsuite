/** My HR → Leave: balances, request history, a new request, and cancelling a request. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useMyHrCancelLeave, useMyHrLeave } from '@/hooks/queries/use-weldhr-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, StatusBadge, errorMessage, formatDate, todayIso } from '../../components/shared';
import { LeaveBalanceTiles } from './leave-balances';
import { LeaveRequestDialog } from './leave-request-dialog';
import { ColorDot, Meta, TabLoading } from './shared';

/** Mirrors the server: pending requests, and approved ones that have not started yet. */
function isCancellable(request: HrSelfLeaveRequest): boolean {
  return request.status === 'pending' || (request.status === 'approved' && request.startDate > todayIso());
}

export function MyLeaveTab({ canRequest }: Readonly<{ canRequest: boolean }>) {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrLeave();
  const cancelLeave = useMyHrCancelLeave();
  const [creating, setCreating] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<HrSelfLeaveRequest | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (isLoading) return <TabLoading />;
  if (!data) return <ErrorBanner error={errorMessage(error, t('weldhr.me.leave.loadFailed'))} />;

  async function confirmCancel(request: HrSelfLeaveRequest) {
    setFailure(null);
    try {
      await cancelLeave.mutateAsync(request.id);
      toast.success(t('weldhr.me.leave.cancelConfirm.toast'));
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.leave.cancelConfirm.failed')));
    } finally {
      setCancelTarget(null);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <SectionCard
        title={t('weldhr.me.leave.balances.title')}
        action={
          canRequest && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.me.leave.requestLeave')}
            </Button>
          )
        }
      >
        <LeaveBalanceTiles balances={data.balances} />
      </SectionCard>

      <SectionCard title={t('weldhr.me.leave.requests.title')} contentClassName="p-0">
        {!canRequest && <p className="px-6 pb-3 text-sm text-muted-foreground">{t('weldhr.me.leave.requestsOff')}</p>}
        {data.requests.length === 0 ? (
          <EmptyText>{t('weldhr.me.leave.requests.empty')}</EmptyText>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.me.leave.requests.table.type')}</TableHead>
                <TableHead>{t('weldhr.me.leave.requests.table.dates')}</TableHead>
                <TableHead>{t('weldhr.me.leave.requests.table.days')}</TableHead>
                <TableHead>{t('weldhr.me.leave.requests.table.status')}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ColorDot color={request.leaveTypeColor} />
                      <span>{request.leaveTypeName ?? '—'}</span>
                    </div>
                    {request.reason && <Meta>{request.reason}</Meta>}
                    {request.reviewNote && <Meta>{t('weldhr.me.leave.requests.reviewNote', { note: request.reviewNote })}</Meta>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(request.startDate)} – {formatDate(request.endDate)}
                  </TableCell>
                  <TableCell className="tabular-nums">{request.days}</TableCell>
                  <TableCell>
                    <StatusBadge group="leave" status={request.status} />
                  </TableCell>
                  <TableCell>
                    {isCancellable(request) && (
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => setCancelTarget(request)}>
                          {t('weldhr.me.leave.requests.cancel')}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {creating && <LeaveRequestDialog types={data.types} onClose={() => setCreating(false)} />}

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
    </div>
  );
}
