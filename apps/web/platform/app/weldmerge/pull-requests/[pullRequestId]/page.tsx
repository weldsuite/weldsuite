import { useState } from 'react';
import { ExternalLink, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import type { MergeIssueLink } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useLinkMergePullRequest,
  useMergePullRequest,
  useUnlinkMergePullRequest,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useParams, useRouter } from '@/lib/router';
import { LinkIssuePopover } from '../../components/link-issue-popover';
import {
  ChecksIndicator,
  IssueStatusIcon,
  LabelChip,
  MarkdownBody,
  ProviderAvatar,
  PullRequestStateBadge,
  PullRequestStateIcon,
  ReviewDecisionBadge,
} from '../../components/primitives';
import { fill, relativeTime } from '../../lib/format';

/**
 * A pull request, read-only: description, state, branches, checks, review
 * decision, reviewers, labels and the issues it is linked to. Members who can
 * update issues can link and unlink them here; reviewing and merging happen on
 * the provider.
 */
export default function WeldMergePullRequestPage() {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tp = tm.pullRequests;
  const router = useRouter();
  const { pullRequestId } = useParams() as { pullRequestId: string };
  const canUpdateIssues = useCan('merge_issues:update');
  const query = useMergePullRequest(pullRequestId);
  const link = useLinkMergePullRequest();
  const unlink = useUnlinkMergePullRequest();
  const [unlinking, setUnlinking] = useState<MergeIssueLink | null>(null);

  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError || !query.data) {
    return <ErrorState message={tp.notFound} retryLabel={tm.retry} onRetry={() => void query.refetch()} />;
  }

  const pr = query.data;
  const provider = tm.provider[pr.provider];

  const subtitle =
    pr.authorLogin && pr.headRef && pr.baseRef
      ? fill(tp.wantsToMerge, { author: pr.authorLogin, head: pr.headRef, base: pr.baseRef })
      : (pr.headRef ?? undefined);

  const handleLink = async (issueId: string) => {
    try {
      await link.mutateAsync({ issueId, input: { pullRequestId: pr.id, closes: true } });
    } catch {
      toast.error(tp.linkFailed);
    }
  };

  const handleUnlink = async () => {
    if (!unlinking) return;
    try {
      await unlink.mutateAsync({ issueId: unlinking.id, pullRequestId: pr.id });
      setUnlinking(null);
    } catch {
      toast.error(tp.unlinkFailed);
    }
  };

  return (
    <DetailPage>
      <DetailHeader
        onBack={() => router.push('/weldmerge/pull-requests')}
        leading={<PullRequestStateIcon state={pr.state} draft={pr.draft} className="mt-2 size-6" />}
        title={
          <>
            {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
          </>
        }
        badges={<PullRequestStateBadge state={pr.state} draft={pr.draft} />}
        subtitle={
          <span>
            {provider} · {pr.repositoryFullName}
            {subtitle ? ` · ${subtitle}` : ''}
          </span>
        }
        actions={
          <Button variant="outline" asChild>
            <a href={pr.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              {fill(tm.openOnProvider, { provider })}
            </a>
          </Button>
        }
      />

      <InfoBanner variant="neutral">{tp.readOnlyNote}</InfoBanner>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <SectionCard title={tp.descriptionHeading}>
            {pr.body ? <MarkdownBody>{pr.body}</MarkdownBody> : <p className="text-sm text-muted-foreground">{tm.noDescription}</p>}
          </SectionCard>
        </div>

        <aside className="space-y-6">
          <SectionCard title={tp.reviewDecision}>
            <div className="space-y-4 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{tp.reviewDecision}</span>
                <ReviewDecisionBadge decision={pr.reviewDecision} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{tp.checksTitle}</span>
                <ChecksIndicator status={pr.checksStatus} withLabel />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{tp.columns.changes}</span>
                <span className="tabular-nums">
                  <span className="text-emerald-600">+{pr.additions ?? 0}</span>{' '}
                  <span className="text-red-500">−{pr.deletions ?? 0}</span>
                  {pr.changedFiles !== null && (
                    <span className="text-muted-foreground"> · {fill(tm.filesChanged, { count: pr.changedFiles })}</span>
                  )}
                </span>
              </div>
              {pr.headRef && pr.baseRef && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">{tp.branch}</span>
                  <span className="min-w-0 truncate">
                    <code className="rounded bg-muted px-1">{pr.headRef}</code> {'→'}{' '}
                    <code className="rounded bg-muted px-1">{pr.baseRef}</code>
                  </span>
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard title={tp.requestedReviewers}>
            {pr.requestedReviewers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tm.noReviewers}</p>
            ) : (
              <ul className="space-y-2">
                {pr.requestedReviewers.map((reviewer) => (
                  <li key={`${reviewer.kind}:${reviewer.login}`} className="flex items-center gap-2 text-sm">
                    <ProviderAvatar login={reviewer.login} avatarUrl={reviewer.avatarUrl} />
                    {reviewer.login}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {pr.labels.length > 0 && (
            <SectionCard title={tp.labels}>
              <div className="flex flex-wrap gap-1.5">
                {pr.labels.map((label) => (
                  <LabelChip key={label.name} name={label.name} color={label.color} />
                ))}
              </div>
            </SectionCard>
          )}

          <SectionCard
            title={tp.linkedIssues}
            action={
              canUpdateIssues ? (
                <LinkIssuePopover
                  excludeIds={pr.issues.map((issue) => issue.id)}
                  pending={link.isPending}
                  onPick={(issueId) => void handleLink(issueId)}
                />
              ) : undefined
            }
          >
            {pr.issues.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tm.noLinkedIssues}</p>
            ) : (
              <ul className="space-y-2">
                {pr.issues.map((issue) => (
                  <li key={issue.id} className="flex items-center gap-2 text-sm">
                    <IssueStatusIcon status={issue.status} />
                    <Link href={`/weldmerge/issues/${issue.key}`} className="min-w-0 flex-1 truncate hover:underline">
                      <span className="text-muted-foreground">{issue.key}</span> {issue.title}
                    </Link>
                    {issue.closes && <span className="shrink-0 text-xs text-muted-foreground">{tp.closesIssue}</span>}
                    {canUpdateIssues && (
                      <Button variant="ghost" size="icon" className="size-7" aria-label={tp.unlink} onClick={() => setUnlinking(issue)}>
                        <Unlink />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <p className="text-xs text-muted-foreground">{fill(tp.syncedAt, { time: relativeTime(pr.syncedAt, language, tm.justNow) })}</p>
        </aside>
      </div>

      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => !open && setUnlinking(null)}
        title={tp.unlinkTitle}
        description={fill(tp.unlinkDescription, { key: unlinking?.key ?? '' })}
        confirmLabel={tp.unlink}
        variant="destructive"
        loading={unlink.isPending}
        onConfirm={handleUnlink}
      />
    </DetailPage>
  );
}
