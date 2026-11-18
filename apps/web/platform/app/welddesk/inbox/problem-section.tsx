import { useState } from 'react';
import { toast } from 'sonner';
import { Link2, Plus, Unlink } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import { deskLinkErrorMessage, deskLinkRefusal } from '@/hooks/queries/use-desk-link-queries';
import {
  useCreateDeskProblem,
  useDeskConversationProblem,
  useSetDeskConversationProblem,
  type DeskProblem,
} from '@/hooks/queries/use-desk-problem-queries';
import { ProblemStatusBadge } from '../problems/problem-status-badge';
import { ProblemPickerDialog } from './problem-picker-dialog';

/**
 * The Problem section of the details panel: the problem this ticket is an
 * incident of, with its workaround for the agent to pass on, and linking,
 * creating a problem from the ticket, and unlinking.
 */
export function ProblemSection({ conversation }: Readonly<{ conversation: DeskConversation }>) {
  const t = getTranslations('deskProblems').inbox;
  const refusals = getTranslations('deskProblems').refusals as Record<string, string>;
  const canUpdate = useCan('conversations:update');
  const canFind = useCan('problems:read');
  const canCreate = useCan('problems:create');
  const { data: problem, isLoading } = useDeskConversationProblem(conversation.id);
  const setProblem = useSetDeskConversationProblem();
  const create = useCreateDeskProblem();
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (isLoading) return null;

  const refusalText = (err: unknown) => {
    const reason = deskLinkRefusal(err);
    return (reason ? refusals[reason] : undefined) ?? deskLinkErrorMessage(err) ?? t.failed;
  };

  const link = (picked: DeskProblem) =>
    setProblem.mutate(
      { id: conversation.id, problemId: picked.id },
      {
        onSuccess: () => {
          setNotice(null);
          setPicking(false);
          toast.success(t.linked.replace('{number}', String(picked.problemNumber)));
        },
        onError: (err) => setNotice(refusalText(err)),
      },
    );

  const unlink = () =>
    setProblem.mutate(
      { id: conversation.id, problemId: null },
      { onSuccess: () => toast.success(t.unlinked), onError: (err) => toast.error(refusalText(err)) },
    );

  const createFromTicket = () => {
    const title = conversation.title?.trim() || t.untitledTicket.replace('{number}', String(conversation.conversationNumber));
    create.mutate(
      { title: title.slice(0, 500), conversationIds: [conversation.id] },
      {
        onSuccess: (res) => toast.success(t.created.replace('{number}', String(res.data.problem.problemNumber))),
        onError: (err) => toast.error(deskLinkErrorMessage(err) ?? t.createFailed),
      },
    );
  };

  const busy = setProblem.isPending || create.isPending;

  return (
    <div className="px-4 py-3 border-b border-border/60" data-testid="desk-inbox-problem">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">{t.title}</p>

      {problem ? (
        <div className="space-y-2 py-1">
          <div className="flex items-center gap-2 text-sm">
            <Link
              href={`/welddesk/problems/${problem.id}`}
              className="min-w-0 flex-1 truncate hover:text-primary"
              title={t.open}
              data-testid="desk-inbox-problem-link"
            >
              #{problem.problemNumber} {problem.title}
            </Link>
            <ProblemStatusBadge status={problem.status} />
          </div>
          {problem.workaround ? (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="desk-inbox-problem-workaround">
              <p className="text-xs font-medium text-muted-foreground">{t.workaround}</p>
              <p className="whitespace-pre-wrap break-words">{problem.workaround}</p>
            </div>
          ) : (
            problem.status === 'known_error' && <p className="text-xs text-muted-foreground">{t.noWorkaround}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-1">{t.none}</p>
      )}

      {canUpdate && (
        <div className="flex flex-wrap gap-1 pt-1">
          {canFind && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPicking(true)} disabled={busy} data-testid="desk-problem-link">
              <Link2 className="h-3.5 w-3.5 mr-1" />
              {t.link}
            </Button>
          )}
          {canCreate && !problem && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={createFromTicket} disabled={busy} data-testid="desk-problem-create">
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t.create}
            </Button>
          )}
          {problem && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={unlink} disabled={busy} data-testid="desk-problem-unlink">
              <Unlink className="h-3.5 w-3.5 mr-1" />
              {t.unlink}
            </Button>
          )}
        </div>
      )}

      <ProblemPickerDialog
        open={picking}
        onOpenChange={(open) => {
          setPicking(open);
          if (!open) setNotice(null);
        }}
        exclude={problem?.id}
        disabled={setProblem.isPending}
        notice={notice ? <InfoBanner variant="warning">{notice}</InfoBanner> : undefined}
        onPick={link}
      />
    </div>
  );
}
