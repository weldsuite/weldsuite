import { useState } from 'react';
import { toast } from 'sonner';
import { Check, ConciergeBell, X } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { LucideDynamicIcon } from '@weldsuite/ui/components/lucide-dynamic-icon';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useUser } from '@/lib/auth';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import type { DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';
import {
  deskCatalogErrorMessage,
  deskCatalogRefusal,
  useAttachDeskCatalogItem,
  useDecideDeskApproval,
  useDeskCatalogItems,
  useDeskConversationRequest,
  type DeskApprovalDecision,
  type DeskConversationRequest,
} from '@/hooks/queries/use-desk-catalog-queries';

type Strings = ReturnType<typeof getTranslations<'deskCatalog'>>['request'];
type StepStatus = DeskConversationRequest['approvals'][number]['status'];

const STEP_TONE: Record<StepStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  waiting: 'neutral',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  skipped: 'neutral',
};

function memberName(members: DeskWorkspaceMember[], userId: string | null): string | null {
  if (!userId) return null;
  return members.find((m) => m.userId === userId)?.name ?? userId;
}

/** The refusal's own sentence when the server named a reason, else its message, else the generic failure. */
function failureMessage(err: unknown, t: Strings): string {
  const reason = deskCatalogRefusal(err);
  if (reason && reason in t.refusals) return t.refusals[reason as keyof typeof t.refusals];
  return deskCatalogErrorMessage(err) ?? t.toast.failed;
}

/** Approve or reject, with an optional note. */
function DecisionDialog({
  decision,
  pending,
  onCancel,
  onConfirm,
  t,
}: Readonly<{
  decision: DeskApprovalDecision | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (comment: string) => void;
  t: Strings;
}>) {
  const [comment, setComment] = useState('');
  const approving = decision === 'approved';
  return (
    <Dialog
      open={decision !== null}
      onOpenChange={(open) => {
        if (!open) {
          setComment('');
          onCancel();
        }
      }}
    >
      <DialogContent data-testid="desk-request-decision-dialog">
        <DialogHeader>
          <DialogTitle>{approving ? t.decision.approveTitle : t.decision.rejectTitle}</DialogTitle>
          <DialogDescription>{t.decision.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="desk-request-comment">{t.decision.commentLabel}</Label>
          <Textarea
            id="desk-request-comment"
            rows={3}
            maxLength={2000}
            value={comment}
            placeholder={t.decision.commentPlaceholder}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {t.decision.cancel}
          </Button>
          <Button
            type="button"
            variant={approving ? 'default' : 'destructive'}
            disabled={pending}
            onClick={() => onConfirm(comment)}
            data-testid="desk-request-decision-confirm"
          >
            {approving ? t.decision.confirmApprove : t.decision.confirmReject}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Pick a catalogue item to make the conversation a request of. */
function ItemPickerDialog({
  open,
  conversationId,
  onClose,
  t,
}: Readonly<{ open: boolean; conversationId: string; onClose: () => void; t: Strings }>) {
  const { data: items = [], isLoading, isError } = useDeskCatalogItems({ enabled: open });
  const attach = useAttachDeskCatalogItem();
  const [selected, setSelected] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const close = () => {
    setSelected(null);
    setRefusal(null);
    onClose();
  };

  const confirm = () => {
    if (!selected) return;
    attach.mutate(
      { conversationId, catalogItemId: selected },
      {
        onSuccess: () => {
          toast.success(t.toast.started);
          close();
        },
        onError: (err) => setRefusal(failureMessage(err, t)),
      },
    );
  };

  let list: React.ReactNode;
  if (isLoading) list = null;
  else if (isError) list = <InfoBanner variant="danger">{t.pickLoadError}</InfoBanner>;
  else if (items.length === 0) list = <p className="text-sm text-muted-foreground">{t.pickEmpty}</p>;
  else {
    list = (
      <ul className="max-h-72 space-y-1 overflow-y-auto" role="listbox" aria-label={t.pickTitle}>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              role="option"
              aria-selected={selected === item.id}
              onClick={() => setSelected(item.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md border p-2 text-left text-sm hover:bg-muted/50',
                selected === item.id && 'border-primary bg-muted/50',
              )}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {item.icon ? <LucideDynamicIcon name={item.icon} className="h-4 w-4" /> : <ConciergeBell className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.name}</span>
                {(item.summary || item.category) && (
                  <span className="block truncate text-xs text-muted-foreground">{item.summary || item.category}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent data-testid="desk-request-picker">
        <DialogHeader>
          <DialogTitle>{t.pickTitle}</DialogTitle>
          <DialogDescription>{t.pickDescription}</DialogDescription>
        </DialogHeader>
        {refusal && <InfoBanner variant="warning">{refusal}</InfoBanner>}
        {list}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={attach.isPending}>
            {t.cancel}
          </Button>
          <Button type="button" onClick={confirm} disabled={!selected || attach.isPending} data-testid="desk-request-start">
            {t.pickConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The service request in the details panel: the catalogue item, where it
 * stands with its approvers, the steps with who decided them and why, and
 * Approve / Reject for the approver (or a catalogue manager). A conversation
 * that is no request offers "Make this a service request" to agents.
 */
export function ServiceRequestSection({
  conversation,
  members,
}: Readonly<{ conversation: DeskConversation; members: DeskWorkspaceMember[] }>) {
  const t = getTranslations('deskCatalog').request;
  const canUpdate = useCan('conversations:update');
  const canManage = useCan('welddesk:settings:update');
  const { user } = useUser();
  const { data: request, isLoading, isError } = useDeskConversationRequest(conversation.id);
  const decide = useDecideDeskApproval();
  const [deciding, setDeciding] = useState<DeskApprovalDecision | null>(null);
  const [picking, setPicking] = useState(false);

  // Hidden when it can't be read (no inbox access): there is nothing useful to say.
  if (isLoading || isError || request === undefined) return null;

  if (request === null) {
    const startable = canUpdate && conversation.state === 'open' && !conversation.mergedIntoId;
    if (!startable) return null;
    return (
      <div className="border-b border-border/60 px-4 py-3" data-testid="desk-service-request">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.title}</p>
        <p className="py-1 text-sm text-muted-foreground">{t.makeHint}</p>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPicking(true)} data-testid="desk-service-request-make">
          <ConciergeBell className="mr-1 h-3.5 w-3.5" />
          {t.makeRequest}
        </Button>
        <ItemPickerDialog open={picking} conversationId={conversation.id} onClose={() => setPicking(false)} t={t} />
      </div>
    );
  }

  const pendingStep = request.approvals.find((step) => step.status === 'pending');
  const mayDecide = Boolean(pendingStep && ((user?.id && pendingStep.approverId === user.id) || canManage));
  let state: { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' } = { label: t.noApproval, tone: 'neutral' };
  if (request.approvalStatus) state = { label: t.states[request.approvalStatus], tone: STEP_TONE[request.approvalStatus] };

  const confirm = (comment: string) => {
    if (!deciding) return;
    const decision = deciding;
    decide.mutate(
      { conversationId: conversation.id, decision, comment },
      {
        onSuccess: () => {
          toast.success(decision === 'approved' ? t.toast.approved : t.toast.rejected);
          setDeciding(null);
        },
        onError: (err) => {
          toast.error(failureMessage(err, t));
          setDeciding(null);
        },
      },
    );
  };

  return (
    <div className="border-b border-border/60 px-4 py-3" data-testid="desk-service-request">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.title}</p>
        <SoftBadge tone={state.tone} data-testid="desk-service-request-state">
          {state.label}
        </SoftBadge>
      </div>
      <div className="flex items-center gap-2 py-1 text-sm">
        {request.item?.icon ? (
          <LucideDynamicIcon name={request.item.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ConciergeBell className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{request.item?.name ?? t.itemRemoved}</span>
      </div>
      {request.item?.deliveryEstimate && (
        <p className="pb-1 text-xs text-muted-foreground">{t.deliveryEstimate.replace('{estimate}', request.item.deliveryEstimate)}</p>
      )}

      {request.approvals.length > 0 && (
        <ol className="space-y-2 py-1" data-testid="desk-request-steps">
          {request.approvals.map((step) => {
            const approver = memberName(members, step.approverId);
            const decidedBy = memberName(members, step.decidedById);
            return (
              <li key={step.id} className="space-y-0.5 text-sm" data-testid="desk-request-step">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{step.stepName || t.step.replace('{number}', String(step.stepIndex + 1))}</span>
                  <SoftBadge tone={STEP_TONE[step.status]}>{t.stepStatus[step.status]}</SoftBadge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {approver ? t.approverLabel.replace('{name}', approver) : t.noApprover}
                  {step.decidedAt && decidedBy ? ` · ${t.decidedBy.replace('{name}', decidedBy)}` : ''}
                </p>
                {step.comment && <p className="whitespace-pre-wrap break-words text-xs italic text-muted-foreground">“{step.comment}”</p>}
              </li>
            );
          })}
        </ol>
      )}

      {mayDecide && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 px-2 text-xs" onClick={() => setDeciding('approved')} data-testid="desk-request-approve">
            <Check className="mr-1 h-3.5 w-3.5" />
            {t.approve}
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setDeciding('rejected')} data-testid="desk-request-reject">
            <X className="mr-1 h-3.5 w-3.5" />
            {t.reject}
          </Button>
        </div>
      )}

      <DecisionDialog decision={deciding} pending={decide.isPending} onCancel={() => setDeciding(null)} onConfirm={confirm} t={t} />
    </div>
  );
}
