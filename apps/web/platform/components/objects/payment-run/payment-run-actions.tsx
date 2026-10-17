/**
 * The workflow of a payment run for the panel: submit, approve, reject, cancel,
 * delete, check the holds again, release a hold, and the dialogs those open
 * (edit the details, say why, confirm). The same actions, toasts and error
 * texts the standalone run page had.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EditRunDialog } from '@/app/weldbooks/payment-runs/components/edit-run-dialog';
import { ReasonDialog } from '@/app/weldbooks/payment-runs/components/reason-dialog';
import { describeRunError } from '@/app/weldbooks/payment-runs/run-errors';
import {
  useApprovePaymentRun,
  useCancelPaymentRun,
  useDeletePaymentRun,
  usePaymentSettings,
  useRejectPaymentRun,
  useReleaseRunHold,
  useSubmitPaymentRun,
  useUpdatePaymentRun,
} from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { useI18n } from '@/lib/i18n/provider';
import type { RunActionBusy, RunActionHandlers } from './run-actions';

export type ConfirmKind = 'cancel' | 'delete';

export function usePaymentRunActions(run: PaymentRunDetail | undefined, onDeleted: () => void) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const td = tp.detail;

  const submit = useSubmitPaymentRun();
  const approve = useApprovePaymentRun();
  const reject = useRejectPaymentRun();
  const cancel = useCancelPaymentRun();
  const remove = useDeletePaymentRun();
  const release = useReleaseRunHold();
  const recheck = useUpdatePaymentRun();

  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

  const fail = (title: string, err: unknown) =>
    toast.error(title, { description: describeRunError(err, tp.errors, tp.errors.generic) });

  const on: RunActionHandlers = {
    onSubmit: () => {
      if (!run) return;
      submit.mutate(run.id, {
        onSuccess: () => toast.success(td.toasts.submitted),
        onError: (err) => fail(td.toasts.submitFailed, err),
      });
    },
    onEdit: () => setEditing(true),
    onRecheck: () => {
      if (!run) return;
      recheck.mutate(
        { id: run.id, input: {} },
        {
          onSuccess: () => toast.success(td.toasts.rechecked),
          onError: (err) => fail(td.toasts.recheckFailed, err),
        },
      );
    },
    onDelete: () => setConfirm('delete'),
    onApprove: () => {
      if (!run) return;
      approve.mutate(run.id, {
        onSuccess: (result) => {
          toast.success(
            result.approved
              ? td.toasts.approved
              : td.toasts.approvalRecorded
                  .replace('{done}', String(result.approvalCount))
                  .replace('{required}', String(result.requiredApprovals)),
          );
        },
        onError: (err) => fail(td.toasts.approveFailed, err),
      });
    },
    onReject: () => setRejecting(true),
    onCancel: () => setConfirm('cancel'),
  };

  const busy: RunActionBusy = {
    submitting: submit.isPending,
    rechecking: recheck.isPending,
    approving: approve.isPending,
  };

  const releaseHold = async (partyId: string, reason: string) => {
    if (!run) return;
    try {
      await release.mutateAsync({ id: run.id, partyId, reason });
      toast.success(td.toasts.holdReleased);
    } catch (err) {
      fail(td.toasts.releaseFailed, err);
      throw err;
    }
  };

  const rejectRun = async (reason: string) => {
    if (!run) return;
    try {
      await reject.mutateAsync({ id: run.id, reason });
      toast.success(td.toasts.rejected);
    } catch (err) {
      fail(td.toasts.rejectFailed, err);
      throw err;
    }
  };

  const cancelRun = async () => {
    if (!run) return;
    try {
      await cancel.mutateAsync(run.id);
      toast.success(td.toasts.cancelled);
    } catch (err) {
      fail(td.toasts.cancelFailed, err);
    } finally {
      setConfirm(null);
    }
  };

  const deleteRun = async () => {
    if (!run) return;
    try {
      await remove.mutateAsync(run.id);
      toast.success(td.toasts.deleted);
      setConfirm(null);
      onDeleted();
    } catch (err) {
      setConfirm(null);
      fail(td.toasts.deleteFailed, err);
    }
  };

  return {
    on,
    busy,
    editing,
    setEditing,
    rejecting,
    setRejecting,
    confirm,
    setConfirm,
    releaseHold,
    rejectRun,
    cancelRun,
    deleteRun,
  };
}

export type PaymentRunActions = ReturnType<typeof usePaymentRunActions>;

/** The dialogs of the run's workflow: edit the details, reject with a reason, confirm a cancel or a delete. */
export function PaymentRunDialogs({
  run,
  actions,
  canManage,
}: Readonly<{ run: PaymentRunDetail; actions: PaymentRunActions; canManage: boolean }>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const td = tp.detail;
  const { editing, setEditing, rejecting, setRejecting, confirm, setConfirm } = actions;

  const settingsQuery = usePaymentSettings(editing && run.method === 'ach' ? run.bankAccountId : undefined);

  return (
    <>
      <EditRunDialog
        run={run}
        open={editing}
        onOpenChange={setEditing}
        canManage={canManage}
        sameDayAllowed={settingsQuery.data?.achSettings.sameDayAllowed ?? false}
      />

      <ReasonDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={td.reject.title}
        description={td.reject.description}
        label={td.reject.reason}
        submitLabel={td.actions.reject}
        destructive
        onSubmit={actions.rejectRun}
      />

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(value) => setConfirm(value ? 'cancel' : null)}
        title={td.cancelConfirm.title}
        description={td.cancelConfirm.description}
        confirmLabel={td.actions.cancel}
        cancelLabel={tp.common.back}
        variant="destructive"
        onConfirm={actions.cancelRun}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(value) => setConfirm(value ? 'delete' : null)}
        title={td.deleteConfirm.title}
        description={td.deleteConfirm.description}
        confirmLabel={td.actions.delete}
        cancelLabel={tp.common.back}
        variant="destructive"
        onConfirm={actions.deleteRun}
      />
    </>
  );
}
