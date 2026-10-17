/**
 * Approve / reject a bill, for the bill panel.
 *
 * The same workflow the standalone bill page had: approving posts the bill to
 * the ledger (and, for US entities, recalculates the use tax: a sales tax rule
 * that refuses shows up as a notice, not a toast), rejecting asks for a reason.
 */

import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { SalesTaxErrorNotice, useDescribeError } from '@/app/weldbooks/invoices/components/sales-tax-error-notice';
import { useApproveBill, useRejectBill } from '@/hooks/queries/use-accounting-queries';
import { salesTaxErrorCode } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';

export function useBillApproval(id: string) {
  const approveBill = useApproveBill();
  const rejectBill = useRejectBill();
  const td = useDocumentTexts();
  const describeError = useDescribeError();

  /** The last approval that a sales tax rule refused (the use tax engine was down, ...). */
  const [taxError, setTaxError] = useState<unknown>(null);
  const [rejectOpen, setRejectOpen] = useState(false);

  const approve = () => {
    setTaxError(null);
    approveBill.mutate(id, {
      onError: (err) => {
        // Approving recalculates the use tax and refuses while the engine can't answer.
        if (salesTaxErrorCode(err)) setTaxError(err);
        else toast.error(td.bill.approveFailed, { description: describeError(err) });
      },
    });
  };

  const reject = (reason: string) => {
    rejectBill.mutate({ id, reason }, { onSuccess: () => setRejectOpen(false) });
  };

  return {
    approve,
    reject,
    approving: approveBill.isPending,
    rejecting: rejectBill.isPending,
    taxError,
    rejectOpen,
    setRejectOpen,
  };
}

export type BillApproval = ReturnType<typeof useBillApproval>;

/** The notice of a refused approval and the approve / reject buttons of a bill that waits for approval. */
export function BillApprovalBar({
  approval,
  canAct,
}: Readonly<{ approval: BillApproval; canAct: boolean }>) {
  const { t } = useI18n();
  const tb = t.accounting.billDetail;
  const hasNotice = approval.taxError !== null;
  if (!canAct && !hasNotice) return null;

  return (
    <div className="space-y-3 px-4 pb-3">
      {hasNotice ? <SalesTaxErrorNotice error={approval.taxError} /> : null}
      {canAct ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={approval.approve} disabled={approval.approving}>
            <Check className="h-4 w-4 mr-1" />
            {tb.approve}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => approval.setRejectOpen(true)}
            disabled={approval.rejecting}
          >
            <X className="h-4 w-4 mr-1" />
            {tb.reject}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function RejectBillDialog({ approval }: Readonly<{ approval: BillApproval }>) {
  const { t } = useI18n();
  const tb = t.accounting.billDetail;
  const [reason, setReason] = useState('');
  const { rejectOpen, setRejectOpen, rejecting, reject } = approval;

  // The reason is not kept once the dialog closes, whether it was rejected or dismissed.
  useEffect(() => {
    if (!rejectOpen) setReason('');
  }, [rejectOpen]);

  const handleReject = () => {
    if (!reason.trim()) return;
    reject(reason);
  };

  return (
    <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tb.rejectBillTitle}</DialogTitle>
          <DialogDescription>{tb.rejectBillDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rejectReason">{tb.rejectReason}</Label>
          <Textarea
            id="rejectReason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder={tb.rejectReasonPlaceholder}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRejectOpen(false)}>
            {tb.cancel}
          </Button>
          <Button variant="destructive" onClick={handleReject} disabled={!reason.trim() || rejecting}>
            {rejecting ? tb.rejecting : tb.rejectConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
