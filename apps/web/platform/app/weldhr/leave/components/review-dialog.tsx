/** Approve or reject a leave request, with an optional note visible to the employee. */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button, buttonVariants } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrLeaveBalances, useReviewHrLeaveRequest } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { ErrorBanner, WarningNote, errorMessage } from '../../components/shared';

export function LeaveReviewDialog({
  request,
  decision,
  onClose,
}: Readonly<{
  request: HrLeaveRequest;
  decision: 'approved' | 'rejected';
  onClose: () => void;
}>) {
  const t = useTranslations();
  const review = useReviewHrLeaveRequest();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const { data: balances } = useHrLeaveBalances(
    decision === 'approved' ? request.employeeId : undefined,
    Number(request.startDate.slice(0, 4)),
  );
  // `remaining` is allowance minus approved days; this request is still pending, so it is not in there yet.
  const balance = balances?.find((b) => b.leaveTypeId === request.leaveTypeId);
  const shortfall = balance && balance.remaining !== null ? Math.round((request.days - balance.remaining) * 10) / 10 : 0;

  async function submit() {
    setFailure(null);
    try {
      await review.mutateAsync({ id: request.id, decision, note: note.trim() || null });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.leave.requests.reviewFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {decision === 'approved' ? t('weldhr.leave.requests.approve') : t('weldhr.leave.requests.reject')}
            {' · '}
            {request.employeeName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <ErrorBanner error={failure} />
          {balance && shortfall > 0 && (
            <WarningNote>
              {t('weldhr.leave.requests.overAllowanceOnApprove', {
                days: request.days,
                remaining: balance.remaining ?? 0,
                type: balance.name,
                over: shortfall,
              })}
            </WarningNote>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="hr-leave-review-note">{t('weldhr.leave.requests.reviewNoteLabel')}</Label>
            <Textarea
              id="hr-leave-review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('weldhr.leave.requests.reviewNotePlaceholder')}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={review.isPending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={review.isPending}
            className={cn(decision === 'rejected' && buttonVariants({ variant: 'destructive' }))}
          >
            {review.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {decision === 'approved' ? t('weldhr.leave.requests.approve') : t('weldhr.leave.requests.reject')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
