/**
 * The staff decision on an order that waits for approval (phase 6): approve or
 * reject, each behind a confirmation with an optional comment for the buyer.
 * `NOT_PENDING` (someone decided first) is said in words and the order reloads.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useApproveCommerceOrder,
  useRejectCommerceOrder,
} from '@/hooks/queries/use-commerce-buyers-queries';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { hasErrorCode, orderErrorMessage } from '@/app/weldcommerce/lib/orders';
import { fill } from '@/app/weldcommerce/lib/text';

export type ApprovalDecision = 'approve' | 'reject';

export function ApprovalDecisionDialog({
  order,
  decision,
  open,
  onOpenChange,
}: Readonly<{ order: Order; decision: ApprovalDecision; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = getTranslations('commerce').orders;
  const ta = t.approval;
  const copy = decision === 'approve' ? ta.approveDialog : ta.rejectDialog;
  const approve = useApproveCommerceOrder();
  const reject = useRejectCommerceOrder();
  const [comment, setComment] = useState('');

  const confirm = async () => {
    const data = comment.trim() ? { comment: comment.trim() } : undefined;
    try {
      if (decision === 'approve') await approve.mutateAsync({ id: order.id, data });
      else await reject.mutateAsync({ id: order.id, data });
      toast.success(decision === 'approve' ? ta.toastApproved : ta.toastRejected);
      onOpenChange(false);
    } catch (err) {
      toast.error(orderErrorMessage(err, t.errors.generic));
      // A decision that came first leaves nothing to confirm: close, the order has reloaded.
      if (hasErrorCode(err, 'NOT_PENDING')) onOpenChange(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setComment('');
        onOpenChange(next);
      }}
      variant={decision === 'reject' ? 'destructive' : 'default'}
      title={fill(copy.title, { number: order.orderNumber })}
      description={
        <span className="block space-y-3">
          <span className="block">{copy.description}</span>
          <label className="block space-y-1.5">
            <span className="block text-sm font-medium text-foreground">{ta.commentLabel}</span>
            <Textarea
              rows={3}
              maxLength={1000}
              value={comment}
              placeholder={ta.commentPlaceholder}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
        </span>
      }
      confirmLabel={copy.confirm}
      cancelLabel={copy.keep}
      onConfirm={confirm}
    />
  );
}
