import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { ArrowLeft, FileText, Pencil, RefreshCw, Send, Trash2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import {
  useApprovePaymentRun,
  useCancelPaymentRun,
  useDeletePaymentRun,
  usePaymentRun,
  usePaymentSettings,
  useRejectPaymentRun,
  useReleaseRunHold,
  useSubmitPaymentRun,
  useUpdatePaymentRun,
} from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import { isWeldbooksRequestError } from '@/lib/api/domains/weldbooks-banking';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { ApprovalControls } from '../components/approval-controls';
import { ApprovalsCard } from '../components/approvals-card';
import { EditRunDialog } from '../components/edit-run-dialog';
import { HistoryCard } from '../components/history-card';
import { HoldsCard } from '../components/holds-card';
import { NachaPanel } from '../components/nacha-panel';
import { PaymentRunsFrame } from '../components/payment-runs-frame';
import { ReasonDialog } from '../components/reason-dialog';
import { RunBillsCard } from '../components/run-bills-card';
import { RunSummaryCard } from '../components/run-summary-card';
import { activeHoldsOf, isRunOpen } from '../payment-run-utils';
import { describeRunError } from '../run-errors';
import { useMemberNames } from '../use-member-names';

export default function PaymentRunDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const td = tp.detail;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { userId } = useAuth();
  const nameOf = useMemberNames();

  const { data: run, isLoading, isError, error, refetch } = usePaymentRun(id);
  const canCreate = can('banking:create');
  const canManage = can('banking:manage');

  const submit = useSubmitPaymentRun();
  const approve = useApprovePaymentRun();
  const reject = useRejectPaymentRun();
  const cancel = useCancelPaymentRun();
  const remove = useDeletePaymentRun();
  const release = useReleaseRunHold();
  const recheck = useUpdatePaymentRun();

  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);

  const settingsQuery = usePaymentSettings(editing && run?.method === 'ach' ? run.bankAccountId : undefined);

  const fail = (title: string, err: unknown) => toast.error(title, { description: describeRunError(err, tp.errors, tp.errors.generic) });

  if (isLoading) {
    return (
      <PaymentRunsFrame title={td.title}>
        <PageLoader fullScreen={false} />
      </PaymentRunsFrame>
    );
  }

  if (isError || !run) {
    const notFound = isWeldbooksRequestError(error) && error.status === 404;
    return (
      <PaymentRunsFrame title={td.title}>
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">{notFound ? td.notFound : tp.common.loadFailed}</p>
          <div className="flex gap-2">
            {!notFound ? <Button variant="outline" size="sm" onClick={() => refetch()}>{tp.common.retry}</Button> : null}
            <Button asChild variant="outline" size="sm">
              <Link to="/weldbooks/payment-runs">{td.backToRuns}</Link>
            </Button>
          </div>
        </div>
      </PaymentRunsFrame>
    );
  }

  const open = isRunOpen(run.status);
  const activeHolds = activeHoldsOf(run.holds);
  const nothingToPay = run.paymentCount === 0;
  const checksToPrint = run.vendors.filter((v) => v.payment?.checkStatus === 'to_print').length;

  const doApprove = (target: PaymentRunDetail) => {
    approve.mutate(target.id, {
      onSuccess: (result) => {
        toast.success(
          result.approved
            ? td.toasts.approved
            : td.toasts.approvalRecorded.replace('{done}', String(result.approvalCount)).replace('{required}', String(result.requiredApprovals)),
        );
      },
      onError: (err) => fail(td.toasts.approveFailed, err),
    });
  };

  const goToRuns = () => navigate({ to: '/weldbooks/payment-runs' });

  return (
    <PaymentRunsFrame
      title={td.title}
      subtitle={run.bankAccountName ? `${run.bankAccountName} · ${run.id}` : run.id}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link to="/weldbooks/payment-runs">
            <ArrowLeft className="h-4 w-4" />
            {td.backToRuns}
          </Link>
        </Button>
      }
    >
      <RunSummaryCard run={run} />

      {activeHolds.length > 0 && open ? (
        <Alert>
          <AlertTitle>{td.heldTitle.replace('{count}', String(new Set(activeHolds.map((h) => h.partyId)).size))}</AlertTitle>
          <AlertDescription>{td.heldDescription}</AlertDescription>
        </Alert>
      ) : null}

      {open && nothingToPay ? (
        <Alert variant="destructive">
          <AlertTitle>{td.nothingToPayTitle}</AlertTitle>
          <AlertDescription>{td.nothingToPayDescription}</AlertDescription>
        </Alert>
      ) : null}

      {run.status === 'draft' || run.status === 'pending_approval' || run.method === 'check' ? (
        <Card>
          <CardHeader>
            <CardTitle>{td.actions.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {run.status === 'draft' ? (
              <>
                <p className="text-sm text-muted-foreground">{td.actions.draftHint}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() =>
                      submit.mutate(run.id, {
                        onSuccess: () => toast.success(td.toasts.submitted),
                        onError: (err) => fail(td.toasts.submitFailed, err),
                      })
                    }
                    disabled={!canCreate || submit.isPending || nothingToPay}
                  >
                    <Send className="h-4 w-4" aria-hidden />
                    {td.actions.submit}
                  </Button>
                  {canCreate ? (
                    <>
                      <Button variant="outline" onClick={() => setEditing(true)}>
                        <Pencil className="h-4 w-4" aria-hidden />
                        {td.actions.edit}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={recheck.isPending}
                        onClick={() =>
                          recheck.mutate(
                            { id: run.id, input: {} },
                            {
                              onSuccess: () => toast.success(td.toasts.rechecked),
                              onError: (err) => fail(td.toasts.recheckFailed, err),
                            },
                          )
                        }
                      >
                        <RefreshCw className="h-4 w-4" aria-hidden />
                        {td.actions.recheckHolds}
                      </Button>
                      <Button variant="outline" onClick={() => setConfirm('delete')}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                        {td.actions.delete}
                      </Button>
                    </>
                  ) : (
                    <p className="self-center text-sm text-muted-foreground">{td.actions.needsCreate}</p>
                  )}
                </div>
              </>
            ) : null}

            {run.status === 'pending_approval' ? (
              <>
                <ApprovalControls
                  run={run}
                  userId={userId}
                  canManage={canManage}
                  busy={approve.isPending}
                  onApprove={() => doApprove(run)}
                  onReject={() => setRejecting(true)}
                />
                {canCreate ? (
                  <div>
                    <Button variant="outline" size="sm" onClick={() => setConfirm('cancel')}>
                      {td.actions.cancel}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}

            {run.method === 'check' && (run.status === 'approved' || run.status === 'completed') ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {checksToPrint > 0 ? td.actions.checksToPrint.replace('{count}', String(checksToPrint)) : td.actions.checksAllPrinted}
                </p>
                {canManage ? (
                  <Button asChild>
                    <Link to="/weldbooks/payment-runs/$id/checks" params={{ id: run.id }}>
                      <FileText className="h-4 w-4" aria-hidden />
                      {checksToPrint > 0 ? td.actions.printChecks : td.actions.openChecks}
                    </Link>
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">{td.actions.needsManage}</p>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <NachaPanel run={run} canManage={canManage} />

      <HoldsCard
        run={run}
        nameOf={nameOf}
        canRelease={canManage && open}
        onRelease={async (partyId, reason) => {
          try {
            await release.mutateAsync({ id: run.id, partyId, reason });
            toast.success(td.toasts.holdReleased);
          } catch (err) {
            fail(td.toasts.releaseFailed, err);
            throw err;
          }
        }}
      />

      <RunBillsCard run={run} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ApprovalsCard run={run} nameOf={nameOf} />
        <HistoryCard history={run.history} nameOf={nameOf} />
      </div>

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
        onSubmit={async (reason) => {
          try {
            await reject.mutateAsync({ id: run.id, reason });
            toast.success(td.toasts.rejected);
          } catch (err) {
            fail(td.toasts.rejectFailed, err);
            throw err;
          }
        }}
      />

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(value) => setConfirm(value ? 'cancel' : null)}
        title={td.cancelConfirm.title}
        description={td.cancelConfirm.description}
        confirmLabel={td.actions.cancel}
        cancelLabel={tp.common.back}
        variant="destructive"
        onConfirm={async () => {
          try {
            await cancel.mutateAsync(run.id);
            toast.success(td.toasts.cancelled);
          } catch (err) {
            fail(td.toasts.cancelFailed, err);
          } finally {
            setConfirm(null);
          }
        }}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(value) => setConfirm(value ? 'delete' : null)}
        title={td.deleteConfirm.title}
        description={td.deleteConfirm.description}
        confirmLabel={td.actions.delete}
        cancelLabel={tp.common.back}
        variant="destructive"
        onConfirm={async () => {
          try {
            await remove.mutateAsync(run.id);
            toast.success(td.toasts.deleted);
            setConfirm(null);
            await goToRuns();
          } catch (err) {
            setConfirm(null);
            fail(td.toasts.deleteFailed, err);
          }
        }}
      />
    </PaymentRunsFrame>
  );
}
