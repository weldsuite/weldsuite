import { SectionCard } from '@weldsuite/ui/components/section-card';
import type { MergeReleaseDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { ChecksIndicator, IssueStatusIcon, PullRequestStateBadge, PullRequestStateIcon } from '../../components/primitives';

/** The merged pull requests a release collects. */
export function ReleasePullRequests({ release }: Readonly<{ release: MergeReleaseDetailDto }>) {
  const { t } = useI18n();
  const td = t.weldmerge.across.releases.detail;
  return (
    <SectionCard title={td.pullRequests}>
      {release.pullRequests.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.noPullRequests}</p>
      ) : (
        <ul className="divide-y">
          {release.pullRequests.map((pr) => (
            <li key={pr.id}>
              <Link
                href={`/weldmerge/pull-requests/${pr.id}`}
                className="flex flex-wrap items-center gap-3 py-2 text-sm hover:bg-muted/50"
              >
                <PullRequestStateIcon state={pr.state} draft={pr.draft} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{pr.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {pr.repositoryFullName} #{pr.number}
                  </span>
                </span>
                <PullRequestStateBadge state={pr.state} draft={pr.draft} />
                <ChecksIndicator status={pr.checksStatus} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** The issues the pull requests close and the desk tickets (customers waiting) linked to them. */
export function ReleaseIssuesAndTickets({ release }: Readonly<{ release: MergeReleaseDetailDto }>) {
  const { t } = useI18n();
  const td = t.weldmerge.across.releases.detail;
  return (
    <>
      <SectionCard title={td.issues}>
        {release.issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">{td.noIssues}</p>
        ) : (
          <ul className="space-y-1">
            {release.issues.map((issue) => (
              <li key={issue.id}>
                <Link
                  href={`/weldmerge/issues/${issue.key}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <IssueStatusIcon status={issue.status} />
                  <span className="shrink-0 text-xs text-muted-foreground">{issue.key}</span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={td.tickets}>
        <p className="mb-2 text-xs text-muted-foreground">{td.ticketsHint}</p>
        {release.tickets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{td.noTickets}</p>
        ) : (
          <ul className="space-y-1">
            {release.tickets.map((ticket) => (
              <li key={`${ticket.ticketId}:${ticket.issueId}`}>
                <Link
                  href={`/welddesk/tickets/${ticket.ticketId}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <span className="min-w-0 flex-1 truncate">{ticket.title ?? ticket.ticketId}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ticket.issueKey}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
