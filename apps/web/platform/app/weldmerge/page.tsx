import { useMemo, useState } from 'react';
import { ExternalLink, GitPullRequest, Inbox as InboxIcon } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { cn } from '@weldsuite/ui/lib/utils';
import type { MergeInboxItem } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useMergeConnections,
  useMergeInbox,
  useMyMergeAccounts,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { GithubUsernameForm } from './components/github-username-form';
import {
  ChecksIndicator,
  IssueStatusIcon,
  PriorityBars,
  PullRequestStateBadge,
  PullRequestStateIcon,
  ReviewDecisionBadge,
  MarkdownBody,
  MemberAvatar,
  useMemberName,
} from './components/primitives';
import { fill, relativeTime } from './lib/format';

/** What an inbox row shows as its title and where it points. */
function itemTitle(item: MergeInboxItem): string {
  return item.pullRequest?.title ?? item.issue?.title ?? '';
}

/**
 * WeldMerge inbox: what needs the member (review requests, failed checks,
 * requested changes, assigned issues), newest first, with a preview of the
 * selected item. The list is derived on the server; nothing here is stored.
 */
export default function WeldMergeInboxPage() {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const canReadConnections = useCan('merge_connections:read');
  const inbox = useMergeInbox();
  const connections = useMergeConnections(canReadConnections);
  const accounts = useMyMergeAccounts();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = useMemo(() => inbox.data ?? [], [inbox.data]);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  if (inbox.isLoading) return <PageLoader fullScreen={false} />;
  if (inbox.isError) {
    return <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void inbox.refetch()} />;
  }

  const noConnection = canReadConnections && connections.isSuccess && connections.data.length === 0;
  const needsUsername = accounts.isSuccess && !accounts.data.github && !noConnection;

  const header = (
    <div className="space-y-3 border-b px-4 py-3">
      <div>
        <h1 className="text-lg font-semibold">{tm.inbox.title}</h1>
        <p className="text-sm text-muted-foreground">{tm.inbox.description}</p>
      </div>
      {needsUsername && (
        <InfoBanner variant="tip" title={tm.inbox.usernameTitle}>
          <p className="mb-2">{tm.inbox.usernameDescription}</p>
          <GithubUsernameForm current={accounts.data?.github ?? null} />
        </InfoBanner>
      )}
    </div>
  );

  if (noConnection && items.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="p-6">
          <EmptyState
            icon={GitPullRequest}
            title={tm.inbox.noConnectionTitle}
            description={tm.inbox.noConnectionDescription}
            action={
              <Button asChild>
                <Link href="/weldmerge/settings">{tm.inbox.openProviders}</Link>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const list = (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={InboxIcon} title={tm.inbox.emptyTitle} description={tm.inbox.emptyDescription} />
          </div>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  aria-current={item.id === selectedId}
                  className={cn(
                    'flex w-full items-start gap-3 border-b px-4 py-3 text-left hover:bg-muted/50',
                    item.id === selectedId && 'bg-muted',
                  )}
                >
                  <span className="mt-0.5">
                    {item.pullRequest ? (
                      <PullRequestStateIcon state={item.pullRequest.state} draft={item.pullRequest.draft} />
                    ) : item.issue ? (
                      <IssueStatusIcon status={item.issue.status} />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{itemTitle(item)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {tm.inbox.kinds[item.kind]}
                      {' · '}
                      {item.pullRequest
                        ? `${item.pullRequest.repositoryFullName} #${item.pullRequest.number}`
                        : item.issue?.key}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeTime(item.at, language, tm.justNow)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <ListDetailLayout list={list} listWidth={440} isDetailSelected={selected !== null}>
      {selected ? (
        <InboxPreview item={selected} onBack={() => setSelectedId(null)} />
      ) : (
        <div className="hidden h-full items-center justify-center text-sm text-muted-foreground md:flex">
          {tm.inbox.selectItem}
        </div>
      )}
    </ListDetailLayout>
  );
}

function InboxPreview({ item, onBack }: Readonly<{ item: MergeInboxItem; onBack: () => void }>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const pr = item.pullRequest;
  const issue = item.issue;
  const assigneeName = useMemberName(issue?.assigneeUserId);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="space-y-4 p-6">
        <Button variant="ghost" size="sm" className="md:hidden" onClick={onBack}>
          {t.common.actions.back}
        </Button>

        <div className="rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium uppercase text-muted-foreground">{tm.inbox.whyTitle}</p>
          <p className="mt-1 text-sm">{tm.inbox.why[item.kind]}</p>
        </div>

        {pr && (
          <>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {tm.provider[pr.provider]} · {pr.repositoryFullName} #{pr.number}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{pr.title}</h2>
                <PullRequestStateBadge state={pr.state} draft={pr.draft} />
              </div>
              {pr.headRef && pr.baseRef && (
                <p className="text-sm text-muted-foreground">
                  <code className="rounded bg-muted px-1">{pr.headRef}</code> {'→'}{' '}
                  <code className="rounded bg-muted px-1">{pr.baseRef}</code>
                </p>
              )}
            </div>

            <dl className="grid grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted-foreground">{tm.pullRequests.checksTitle}</dt>
              <dd>
                <ChecksIndicator status={pr.checksStatus} withLabel />
              </dd>
              <dt className="text-muted-foreground">{tm.pullRequests.reviewDecision}</dt>
              <dd>
                <ReviewDecisionBadge decision={pr.reviewDecision} />
              </dd>
              <dt className="text-muted-foreground">{tm.pullRequests.columns.changes}</dt>
              <dd>
                <span className="text-emerald-600">+{pr.additions ?? 0}</span>{' '}
                <span className="text-red-500">−{pr.deletions ?? 0}</span>
                {pr.changedFiles !== null && (
                  <span className="text-muted-foreground"> · {fill(tm.filesChanged, { count: pr.changedFiles })}</span>
                )}
              </dd>
              <dt className="text-muted-foreground">{tm.linkedIssue}</dt>
              <dd className="flex flex-wrap gap-2">
                {pr.issues.length === 0 ? (
                  <span className="text-muted-foreground">{tm.noLinkedIssues}</span>
                ) : (
                  pr.issues.map((linked) => (
                    <Link
                      key={linked.id}
                      href={`/weldmerge/issues/${linked.key}`}
                      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 hover:bg-muted"
                    >
                      <IssueStatusIcon status={linked.status} className="size-3.5" />
                      {linked.key}
                    </Link>
                  ))
                )}
              </dd>
            </dl>

            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href={`/weldmerge/pull-requests/${pr.id}`}>{tm.inbox.openPullRequest}</Link>
              </Button>
              <Button variant="outline" asChild>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  {fill(tm.openOnProvider, { provider: tm.provider[pr.provider] })}
                </a>
              </Button>
            </div>
          </>
        )}

        {!pr && issue && (
          <>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{issue.key}</p>
              <h2 className="text-xl font-semibold">{issue.title}</h2>
            </div>
            <dl className="grid grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted-foreground">{tm.issue.status}</dt>
              <dd className="flex items-center gap-2">
                <IssueStatusIcon status={issue.status} />
                {tm.status[issue.status]}
              </dd>
              <dt className="text-muted-foreground">{tm.issue.priority}</dt>
              <dd className="flex items-center gap-2">
                <PriorityBars priority={issue.priority} />
                {tm.priority[issue.priority]}
              </dd>
              <dt className="text-muted-foreground">{tm.issue.assignee}</dt>
              <dd className="flex items-center gap-2">
                {issue.assigneeUserId ? <MemberAvatar userId={issue.assigneeUserId} /> : null}
                {assigneeName ?? tm.unassigned}
              </dd>
              <dt className="text-muted-foreground">{tm.pullRequests.columns.updated}</dt>
              <dd>{relativeTime(issue.updatedAt, language, tm.justNow)}</dd>
            </dl>
            {issue.description && <MarkdownBody>{issue.description}</MarkdownBody>}
            <Button asChild>
              <Link href={`/weldmerge/issues/${issue.key}`}>{tm.inbox.openIssue}</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
