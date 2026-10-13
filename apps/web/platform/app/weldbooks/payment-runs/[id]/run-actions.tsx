import { Link } from '@tanstack/react-router';
import { FileText, Pencil, RefreshCw, Send, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { useI18n } from '@/lib/i18n/provider';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { ApprovalControls } from '../components/approval-controls';
import { activeHoldsOf, isRunOpen } from '../payment-run-utils';

type RunActionHandlers = {
  onSubmit: () => void;
  onEdit: () => void;
  onRecheck: () => void;
  onDelete: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
};

type RunActionBusy = {
  submitting: boolean;
  rechecking: boolean;
  approving: boolean;
};

/** Banners for a run that is still open: payments held back, or nothing left to pay. */
export function RunAlerts({ run }: Readonly<{ run: PaymentRunDetail }>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.payments.detail;
  const open = isRunOpen(run.status);
  const activeHolds = activeHoldsOf(run.holds);
  const nothingToPay = run.paymentCount === 0;
  return (
    <>
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
    </>
  );
}

function DraftActions({
  canCreate,
  nothingToPay,
  busy,
  on,
}: Readonly<{ canCreate: boolean; nothingToPay: boolean; busy: RunActionBusy; on: RunActionHandlers }>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.payments.detail;
  return (
    <>
      <p className="text-sm text-muted-foreground">{td.actions.draftHint}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={on.onSubmit} disabled={!canCreate || busy.submitting || nothingToPay}>
          <Send className="h-4 w-4" aria-hidden />
          {td.actions.submit}
        </Button>
        {canCreate ? (
          <>
            <Button variant="outline" onClick={on.onEdit}>
              <Pencil className="h-4 w-4" aria-hidden />
              {td.actions.edit}
            </Button>
            <Button variant="outline" disabled={busy.rechecking} onClick={on.onRecheck}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              {td.actions.recheckHolds}
            </Button>
            <Button variant="outline" onClick={on.onDelete}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {td.actions.delete}
            </Button>
          </>
        ) : (
          <p className="self-center text-sm text-muted-foreground">{td.actions.needsCreate}</p>
        )}
      </div>
    </>
  );
}

function PendingApprovalActions({
  run,
  userId,
  canCreate,
  canManage,
  busy,
  on,
}: Readonly<{
  run: PaymentRunDetail;
  userId: string | null | undefined;
  canCreate: boolean;
  canManage: boolean;
  busy: RunActionBusy;
  on: RunActionHandlers;
}>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.payments.detail;
  return (
    <>
      <ApprovalControls
        run={run}
        userId={userId}
        canManage={canManage}
        busy={busy.approving}
        onApprove={on.onApprove}
        onReject={on.onReject}
      />
      {canCreate ? (
        <div>
          <Button variant="outline" size="sm" onClick={on.onCancel}>
            {td.actions.cancel}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function CheckActions({ run, canManage }: Readonly<{ run: PaymentRunDetail; canManage: boolean }>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.payments.detail;
  const checksToPrint = run.vendors.filter((v) => v.payment?.checkStatus === 'to_print').length;
  const hasChecksToPrint = checksToPrint > 0;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {hasChecksToPrint ? td.actions.checksToPrint.replace('{count}', String(checksToPrint)) : td.actions.checksAllPrinted}
      </p>
      {canManage ? (
        <Button asChild>
          <Link to="/weldbooks/payment-runs/$id/checks" params={{ id: run.id }}>
            <FileText className="h-4 w-4" aria-hidden />
            {hasChecksToPrint ? td.actions.printChecks : td.actions.openChecks}
          </Link>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{td.actions.needsManage}</p>
      )}
    </div>
  );
}

/** What the member can do with the run in its current status (nothing, for most settled runs). */
export function RunActionsCard({
  run,
  userId,
  canCreate,
  canManage,
  busy,
  on,
}: Readonly<{
  run: PaymentRunDetail;
  userId: string | null | undefined;
  canCreate: boolean;
  canManage: boolean;
  busy: RunActionBusy;
  on: RunActionHandlers;
}>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.payments.detail;
  if (run.status !== 'draft' && run.status !== 'pending_approval' && run.method !== 'check') return null;
  const nothingToPay = run.paymentCount === 0;
  const checksReady = run.method === 'check' && (run.status === 'approved' || run.status === 'completed');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{td.actions.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {run.status === 'draft' ? (
          <DraftActions canCreate={canCreate} nothingToPay={nothingToPay} busy={busy} on={on} />
        ) : null}

        {run.status === 'pending_approval' ? (
          <PendingApprovalActions
            run={run}
            userId={userId}
            canCreate={canCreate}
            canManage={canManage}
            busy={busy}
            on={on}
          />
        ) : null}

        {checksReady ? <CheckActions run={run} canManage={canManage} /> : null}
      </CardContent>
    </Card>
  );
}
