import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { approvalStateOf, type ApprovalNote } from '../payment-run-utils';

interface ApprovalControlsProps {
  run: PaymentRunDetail;
  /** The signed-in person's Clerk user id. */
  userId: string | null | undefined;
  /** The person has `banking:manage`. */
  canManage: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * The approve, finish-approval and reject buttons of a run that waits for
 * approval, with the note that says why a button is off.
 */
export function ApprovalControls({ run, userId, canManage, busy, onApprove, onReject }: Readonly<ApprovalControlsProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.payments.detail.actions;
  const notes: Readonly<Record<ApprovalNote, string>> = ta.approvalNotes;
  const state = approvalStateOf(run, userId, canManage);

  if (state.action === 'none') return null;

  const label = state.action === 'finish' ? ta.finishApproval : ta.approve;
  const note = state.note ? notes[state.note] : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onApprove} disabled={!state.enabled || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
          {label}
        </Button>
        {state.action === 'approve' && canManage ? (
          <Button variant="outline" onClick={onReject} disabled={busy}>
            <XCircle className="h-4 w-4" aria-hidden />
            {ta.reject}
          </Button>
        ) : null}
      </div>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
