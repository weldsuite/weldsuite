import { useMemo, useState } from 'react';
import { CheckCircle2, CircleSlash, ShieldAlert, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useAgentApprovals, useDecideAgentApproval } from '@/hooks/queries/use-agent-parity-queries';
import {
  approvalCardState,
  readMessageApprovals,
  type ApprovalCardState,
  type MessageApproval,
} from '../lib/message-approvals';

type LocalDecision = 'approved' | 'rejected' | 'handled';

const STATE_STYLE: Record<ApprovalCardState, string> = {
  waiting: 'border-amber-500/30 bg-amber-500/[0.04]',
  approved: 'border-emerald-500/30 bg-emerald-500/[0.04]',
  rejected: 'border-border bg-muted/40',
  handled: 'border-border bg-muted/40',
};

function StateIcon({ state }: Readonly<{ state: ApprovalCardState }>) {
  const className = 'mt-0.5 h-3.5 w-3.5 shrink-0';
  if (state === 'approved') return <CheckCircle2 className={cn(className, 'text-emerald-600 dark:text-emerald-400')} />;
  if (state === 'rejected') return <XCircle className={cn(className, 'text-muted-foreground')} />;
  if (state === 'handled') return <CircleSlash className={cn(className, 'text-muted-foreground')} />;
  return <ShieldAlert className={cn(className, 'text-amber-600')} />;
}

function ApprovalCard({
  approval,
  agentId,
  askedAt,
}: Readonly<{ approval: MessageApproval; agentId: string; askedAt?: string | null }>) {
  const { t } = useI18n();
  const strings = t.weldchat.approvalCard;
  const canDecide = useCan('weldagent:use');
  const [local, setLocal] = useState<LocalDecision | null>(null);

  // The agent's still-pending approvals tell a card that someone else got there first.
  // Not read for people who cannot decide (they only see the card).
  const { data: pendingList, isFetchedAfterMount } = useAgentApprovals(canDecide ? agentId : '');
  const pending = useMemo(
    () => (canDecide && isFetchedAfterMount && pendingList ? new Set(pendingList.map((a) => a.id)) : null),
    [canDecide, isFetchedAfterMount, pendingList],
  );
  const decide = useDecideAgentApproval(agentId);

  const state = approvalCardState({ approval, local, pending, askedAt });
  const labels: Record<ApprovalCardState, string> = {
    waiting: strings.waitingFor,
    approved: strings.approved,
    rejected: strings.rejected,
    handled: strings.alreadyHandled,
  };

  const submit = async (decision: 'approved' | 'rejected') => {
    setLocal(decision); // optimistic
    try {
      const res = await decide.mutateAsync({ id: approval.id, decision });
      if (decision === 'approved' && res?.execution && !res.execution.ok) {
        toast.error(strings.actionFailed.replace('{error}', res.execution.error ?? ''));
      }
    } catch (err) {
      if (isApiError(err) && (err.status === 404 || err.status === 409)) {
        // Decided elsewhere in the meantime: not an error, just not ours to decide any more.
        setLocal('handled');
        return;
      }
      setLocal(null);
      toast.error(isApiError(err) && err.status === 403 ? strings.notAllowed : strings.decideFailed);
    }
  };

  return (
    <div
      data-testid="chat-message-approval"
      data-approval-state={state}
      aria-live="polite"
      className={cn('flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs', STATE_STYLE[state])}
    >
      <StateIcon state={state} />
      <span className="min-w-0 flex-1 break-words py-0.5">{labels[state].replace('{label}', approval.label)}</span>
      {state === 'waiting' && canDecide && (
        <div className="flex shrink-0 gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={decide.isPending}
            onClick={() => void submit('rejected')}
          >
            {strings.reject}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={decide.isPending}
            onClick={() => void submit('approved')}
          >
            {strings.approve}
          </Button>
        </div>
      )}
    </div>
  );
}

interface MessageApprovalsProps {
  message: {
    authorId?: string | null;
    authorType?: string;
    metadata?: unknown;
    createdAt?: string | null;
  };
}

/**
 * What an agent's message is waiting on a person for: one compact card per
 * parked action, under the message, with Approve / Reject for people who may
 * decide it. Renders nothing for any other message.
 */
export function MessageApprovals({ message }: Readonly<MessageApprovalsProps>) {
  const approvals = useMemo(() => readMessageApprovals(message.metadata), [message.metadata]);
  if (message.authorType !== 'agent' || !message.authorId || approvals.length === 0) return null;

  return (
    <div data-testid="chat-message-approvals" className="mt-2 space-y-1.5">
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} agentId={message.authorId as string} askedAt={message.createdAt} />
      ))}
    </div>
  );
}
