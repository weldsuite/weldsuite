import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Hourglass, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { useI18n } from '@/lib/i18n/provider';
import { useEditorWorkspaceMembers } from '@/hooks/use-workflow-editor-data';
import {
  isAlreadyDecidedError,
  useDecideApproval,
  usePendingApproval,
} from '@/hooks/queries/use-automation-queries';

interface ApprovalPanelProps {
  executionId: string;
}

/**
 * The approval a run waits on (a `manual_step`): what to decide, who may, and
 * Approve / Reject with an optional comment for those who may. The decision
 * resumes the run (connect-api POST /workflow-executions/:id/decision).
 */
export function ApprovalPanel({ executionId }: Readonly<ApprovalPanelProps>) {
  const { t } = useI18n();
  const ta = t.weldconnect.executionDetail.approval;
  const { data } = usePendingApproval(executionId);
  const { data: members = [] } = useEditorWorkspaceMembers();
  const decide = useDecideApproval();
  const [comment, setComment] = useState('');

  const approval = data?.data?.approval;
  if (!approval) return null;
  const canDecide = data?.data?.canDecide === true;

  const approverNames = approval.approverIds
    .map((id) => members.find((member) => member.id === id)?.name ?? id)
    .join(', ');

  const submit = (decision: 'approved' | 'rejected') => {
    decide.mutate(
      { id: executionId, decision, comment: comment.trim() || null },
      {
        onSuccess: () => {
          toast.success(decision === 'approved' ? ta.approved : ta.rejected);
          setComment('');
        },
        onError: (err) => toast.error(isAlreadyDecidedError(err) ? ta.alreadyDecided : ta.failed),
      },
    );
  };

  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <div className="flex items-start gap-3">
        <Hourglass className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">{ta.title}</p>
            {approval.title && (
              <p className="font-semibold text-amber-950 dark:text-amber-100 [overflow-wrap:anywhere]">{approval.title}</p>
            )}
            {approval.description && (
              <p className="mt-1 whitespace-pre-wrap text-sm text-amber-900 dark:text-amber-200 [overflow-wrap:anywhere]">
                {approval.description}
              </p>
            )}
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {approval.approverIds.length > 0 ? ta.approvers.replace('{names}', approverNames) : ta.anyManager}
          </p>
          {canDecide ? (
            <div className="space-y-2 pt-1">
              <Label htmlFor="approval-comment" className="text-xs">{ta.commentLabel}</Label>
              <Textarea
                id="approval-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={ta.commentPlaceholder}
                maxLength={2000}
                rows={2}
                className="bg-background"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="h-8" onClick={() => submit('approved')} disabled={decide.isPending}>
                  <Check className="mr-1 h-4 w-4" />
                  {ta.approve}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => submit('rejected')}
                  disabled={decide.isPending}
                >
                  <X className="mr-1 h-4 w-4" />
                  {ta.reject}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-amber-800 dark:text-amber-300">{ta.notAllowed}</p>
          )}
          <p className="text-xs text-amber-700/80 dark:text-amber-400/80">{ta.expiresNote}</p>
        </div>
      </div>
    </div>
  );
}
