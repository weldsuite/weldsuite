import { useState } from 'react';
import { toast } from 'sonner';
import { Link2, Unlink } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import { deskLinkErrorMessage, deskLinkRefusal } from '@/hooks/queries/use-desk-link-queries';
import {
  useDeskProblemIncidents,
  useSetDeskConversationProblem,
  type DeskProblem,
} from '@/hooks/queries/use-desk-problem-queries';
import { ticketHref } from '../inbox/linked-tickets-section';
import { TicketPickerDialog, customerLabel } from '../inbox/ticket-picker-dialog';

/** The tickets linked to a problem, with linking (the ticket picker) and unlinking. */
export function ProblemIncidentsCard({ problem, canUpdate }: Readonly<{ problem: DeskProblem; canUpdate: boolean }>) {
  const all = getTranslations('deskProblems');
  const t = all.detail.incidents;
  const refusals = all.refusals as Record<string, string>;
  const { data: incidents, isLoading, isError, refetch } = useDeskProblemIncidents(problem.id);
  const setProblem = useSetDeskConversationProblem();
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const closed = problem.status === 'closed';

  const refusalText = (err: unknown) => {
    const reason = deskLinkRefusal(err);
    return (reason ? refusals[reason] : undefined) ?? deskLinkErrorMessage(err) ?? t.failed;
  };

  const link = (picked: DeskConversation) =>
    setProblem.mutate(
      { id: picked.id, problemId: problem.id },
      {
        onSuccess: () => {
          setNotice(null);
          setPicking(false);
          toast.success(t.linked);
        },
        onError: (err) => setNotice(refusalText(err)),
      },
    );

  const unlink = (id: string) =>
    setProblem.mutate(
      { id, problemId: null },
      { onSuccess: () => toast.success(t.unlinked), onError: (err) => toast.error(refusalText(err)) },
    );

  const counts = t.openCount.replace('{open}', String(problem.openIncidentCount)).replace('{total}', String(problem.incidentCount));

  return (
    <SectionCard
      title={t.title}
      description={`${t.description} ${counts}`}
      action={
        canUpdate && (
          <Button variant="outline" size="sm" onClick={() => setPicking(true)} disabled={closed} data-testid="desk-problem-link-ticket">
            <Link2 className="mr-1.5 h-4 w-4" />
            {t.link}
          </Button>
        )
      }
    >
      {closed && (
        <InfoBanner variant="info" className="mb-3">
          {all.detail.closedNotice}
        </InfoBanner>
      )}
      {isLoading && <PageLoader />}
      {isError && <ErrorState message={all.detail.loadError} onRetry={() => void refetch()} />}
      {incidents && incidents.length === 0 && <EmptyText>{t.empty}</EmptyText>}
      {incidents && incidents.length > 0 && (
        <div className="divide-y">
          {incidents.map((ticket) => (
            <div key={ticket.id} className="flex items-center gap-3 py-2 text-sm" data-testid="desk-problem-incident">
              <span
                className={cn('h-2 w-2 shrink-0 rounded-full', ticket.state === 'open' ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                title={ticket.state === 'open' ? t.open : t.closed}
              />
              <Link
                href={ticketHref(ticket)}
                className="min-w-0 flex-1"
                title={t.openTicket.replace('{number}', String(ticket.conversationNumber))}
              >
                <span className="block truncate hover:text-primary">
                  #{ticket.conversationNumber} {ticket.title || t.untitled}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{customerLabel(ticket)}</span>
              </Link>
              {canUpdate && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                  onClick={() => unlink(ticket.id)}
                  disabled={setProblem.isPending}
                  aria-label={t.unlink}
                  title={t.unlink}
                >
                  <Unlink className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <TicketPickerDialog
        open={picking}
        onOpenChange={(open) => {
          setPicking(open);
          if (!open) setNotice(null);
        }}
        title={t.linkTitle}
        description={t.linkDescription}
        exclude={(incidents ?? []).map((ticket) => ticket.id)}
        disabled={setProblem.isPending}
        notice={notice ? <InfoBanner variant="warning">{notice}</InfoBanner> : undefined}
        onPick={link}
      />
    </SectionCard>
  );
}
