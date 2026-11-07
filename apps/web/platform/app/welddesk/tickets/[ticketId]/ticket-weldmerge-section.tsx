import { useEffect, useState } from 'react';
import { GitPullRequestArrow, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { CreateMergeIssueInput } from '@weldsuite/app-api-client/schemas/weldmerge';
import { IssueStatusIcon } from '@/app/weldmerge/components/primitives';
import { fill } from '@/app/weldmerge/lib/format';
import { useEscalateToMergeIssue, useMergeRecordLinks } from '@/hooks/queries/use-weldmerge-across-queries';
import { useMergeTeams } from '@/hooks/queries/use-weldmerge-queries';
import { useTicket } from '@/hooks/queries/use-helpdesk-queries';
import { useAppAccess } from '@/hooks/use-app-access';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';

/** The ticket row fields the escalation reads beyond `ApiTicket`: the CRM company the ticket belongs to. */
interface TicketCompanyFields {
  counterpartyId?: string | null;
  customerCompany?: string | null;
}

/** The WeldMerge section shows only where the app is installed and the member may read issues. */
export function useWeldMergeTicketAccess(): boolean {
  const { isInstalled, isLoading } = useAppAccess('weldmerge');
  const canRead = useCan('merge_issues:read');
  return !isLoading && isInstalled && canRead;
}

/**
 * The links of an escalation: the ticket itself and, when the ticket belongs
 * to a company, that company. Pure so it can be tested on its own.
 */
export function buildEscalationLinks(
  ticket: { id: string; subject: string },
  company: { id: string | null | undefined; name: string | null | undefined },
): NonNullable<CreateMergeIssueInput['links']> {
  const links: NonNullable<CreateMergeIssueInput['links']> = [
    { recordType: 'desk_ticket', recordId: ticket.id, title: ticket.subject },
  ];
  if (company.id) links.push({ recordType: 'crm_company', recordId: company.id, title: company.name ?? null });
  return links;
}

function EscalateDialog({
  open,
  onOpenChange,
  ticketId,
  subject,
  description,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; ticketId: string; subject: string; description: string }>) {
  const { t } = useI18n();
  const td = t.weldmerge.across.desk;
  const teams = useMergeTeams();
  const ticketQuery = useTicket(ticketId, open);
  const escalate = useEscalateToMergeIssue();
  const company = (ticketQuery.data?.data ?? {}) as TicketCompanyFields;

  const [teamId, setTeamId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(subject);
    setBody(description);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefill when the dialog opens
  }, [open]);

  useEffect(() => {
    if (open && !teamId && teams.data?.[0]) setTeamId(teams.data[0].id);
  }, [open, teamId, teams.data]);

  const submit = async () => {
    if (title.trim() === '') {
      toast.error(td.titleRequired);
      return;
    }
    try {
      const issue = await escalate.mutateAsync({
        teamId,
        title: title.trim(),
        description: body.trim() === '' ? null : body.trim(),
        links: buildEscalationLinks(
          { id: ticketId, subject },
          { id: company.counterpartyId, name: company.customerCompany },
        ),
      });
      toast.success(fill(td.created, { key: issue.key }));
      onOpenChange(false);
    } catch {
      toast.error(td.createFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{td.escalateTitle}</DialogTitle>
          <DialogDescription>{td.escalateDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{td.team}</Label>
            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger className="w-full" aria-label={td.team}>
                <SelectValue placeholder={td.selectTeam} />
              </SelectTrigger>
              <SelectContent>
                {(teams.data ?? []).map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name} ({team.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {teams.isSuccess && teams.data.length === 0 && <p className="text-xs text-muted-foreground">{td.noTeams}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="escalate-title">{td.issueTitle}</Label>
            <Input id="escalate-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="escalate-description">{td.issueDescription}</Label>
            <Textarea id="escalate-description" rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.common.actions.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={escalate.isPending || teamId === ''}>
            {escalate.isPending && <Loader2 className="animate-spin" />}
            {td.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Body of the ticket sidebar's WeldMerge section: the issues linked to the
 * ticket with their status, team key and the release that shipped them, and
 * *Escalate to issue* for members who may create issues.
 */
export function TicketWeldMergeSection({
  ticketId,
  subject,
  description,
}: Readonly<{ ticketId: string; subject: string; description: string }>) {
  const { t } = useI18n();
  const td = t.weldmerge.across.desk;
  const canCreate = useCan('merge_issues:create');
  const links = useMergeRecordLinks('desk_ticket', ticketId);
  const [escalating, setEscalating] = useState(false);
  const rows = links.data ?? [];

  return (
    <div className="space-y-2" data-testid="ticket-weldmerge-section">
      {links.isError && <p className="text-[13px] text-destructive">{td.loadFailed}</p>}
      {!links.isError && rows.length === 0 && !links.isLoading && (
        <p className="text-[13px] text-muted-foreground">{td.empty}</p>
      )}
      {!links.isError && rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map(({ link, issue, release }) => (
            <li key={link.id}>
              <Link
                href={`/weldmerge/issues/${issue.key}`}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted"
              >
                <IssueStatusIcon status={issue.status} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <span className="text-muted-foreground">{issue.key}</span> {issue.title}
                  </span>
                  {release && (
                    <span className="block truncate text-xs text-emerald-700 dark:text-emerald-400">
                      {fill(td.shippedIn, { release: release.version ? `${release.name} ${release.version}` : release.name })}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canCreate && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setEscalating(true)}>
          <GitPullRequestArrow />
          {td.escalate}
        </Button>
      )}
      <EscalateDialog open={escalating} onOpenChange={setEscalating} ticketId={ticketId} subject={subject} description={description} />
    </div>
  );
}
