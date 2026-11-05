import { useState } from 'react';
import { ExternalLink, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import type { MergeIssueLink } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeMethod, MergeReviewEvent, MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import {
  useLinkMergePullRequest,
  useMergePullRequest,
  useUnlinkMergePullRequest,
} from '@/hooks/queries/use-weldmerge-queries';
import {
  reviewErrorCode,
  useCreateMergePullRequestComment,
  useMergePullRequestOnProvider,
  useSubmitMergeReview,
} from '@/hooks/queries/use-weldmerge-review-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useParams, useRouter } from '@/lib/router';
import type { DraftComment } from '../../components/diff/file-diff';
import { FilesChanged } from '../../components/diff/files-changed';
import { LinkIssuePopover } from '../../components/link-issue-popover';
import { Conversation } from '../../components/review/conversation';
import { MergeBox } from '../../components/review/merge-box';
import { ReviewPopover } from '../../components/review/review-popover';
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
 * A pull request: description, state, branches, checks, review decision,
 * reviewers, labels and linked issues (Overview), the diff with inline review
 * threads (Files changed) and the conversation. Members with
 * `merge_pull_requests:review` review and comment as their own linked provider
 * account, with `:merge` they merge; members who can update issues link and
 * unlink them.
 */

type PullRequestTab = 'overview' | 'files' | 'conversation';
let draftSequence = 0;
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
  const canReview = useCan('merge_pull_requests:review');
  const canMerge = useCan('merge_pull_requests:merge');
  const submitReview = useSubmitMergeReview(pullRequestId);
  const createComment = useCreateMergePullRequestComment(pullRequestId);
  const mergeOnProvider = useMergePullRequestOnProvider(pullRequestId);
  const [unlinking, setUnlinking] = useState<MergeIssueLink | null>(null);
  const [tab, setTab] = useState<PullRequestTab>('overview');
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [notLinked, setNotLinked] = useState(false);

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

  const tr = tm.reviewing;

  /** An unlinked account gets its notice; a provider refusal shows the provider's own words. */
  const reportFailure = (error: unknown, fallback: string) => {
    const code = reviewErrorCode(error);
    if (code === 'account_not_linked') {
      setNotLinked(true);
      return;
    }
    const message = error instanceof Error && error.message ? error.message : '';
    if (code === 'not_mergeable') toast.error(message || tr.errors.notMergeable);
    else if (code === 'provider_error') toast.error(message || tr.errors.providerError);
    else toast.error(message || fallback);
  };

  const addDraft = (draft: Omit<DraftComment, 'id'>) => setDrafts((current) => [...current, { ...draft, id: `draft_${++draftSequence}` }]);
  const removeDraft = (id: string) => setDrafts((current) => current.filter((draft) => draft.id !== id));

  /** Posts one comment (line comment, reply or general) and reports a failure; rethrows so the caller keeps its text. */
  const postComment = async (input: Parameters<typeof createComment.mutateAsync>[0], announce: boolean) => {
    try {
      await createComment.mutateAsync(input);
      setNotLinked(false);
      if (announce) toast.success(tr.conversation.sent);
    } catch (error) {
      reportFailure(error, tr.errors.commentFailed);
      throw error;
    }
  };

  const commentNow = (draft: Omit<DraftComment, 'id'>) =>
    postComment({ body: draft.body, path: draft.path, line: draft.line, side: draft.side }, true);
  const reply = (thread: MergeReviewThread, body: string) => postComment({ body, inReplyToId: thread.id }, false);
  const generalComment = (body: string) => postComment({ body }, true);

  const review = async (event: MergeReviewEvent, body: string) => {
    try {
      await submitReview.mutateAsync({
        event,
        ...(body ? { body } : {}),
        ...(drafts.length > 0 ? { comments: drafts.map(({ path, line, side, body: text }) => ({ path, line, side, body: text })) } : {}),
      });
      setDrafts([]);
      setNotLinked(false);
      toast.success(tr.review.submitted);
    } catch (error) {
      reportFailure(error, tr.review.failed);
      throw error;
    }
  };

  const merge = async (input: { method: MergeMethod; commitTitle?: string; commitMessage?: string }) => {
    try {
      await mergeOnProvider.mutateAsync(input);
      setNotLinked(false);
      toast.success(tr.merge.merged);
    } catch (error) {
      reportFailure(error, tr.merge.failed);
      throw error;
    }
  };

  const tabs: PageTab[] = [
    { id: 'overview', label: tr.tabs.overview },
    { id: 'files', label: tr.tabs.files },
    { id: 'conversation', label: tr.tabs.conversation },
  ];

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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" asChild>
              <a href={pr.url} target="_blank" rel="noreferrer">
                <ExternalLink />
                {fill(tm.openOnProvider, { provider })}
              </a>
            </Button>
            {canReview && pr.state === 'open' && (
              <ReviewPopover pendingCount={drafts.length} submitting={submitReview.isPending} onSubmit={review} />
            )}
          </div>
        }
      />

      {!canReview && !canMerge && <InfoBanner variant="neutral">{tp.readOnlyNote}</InfoBanner>}

      {notLinked && (
        <InfoBanner variant="warning">
          {fill(tr.errors.accountNotLinked, { provider })}{' '}
          <Link href="/weldmerge/settings?tab=accounts" className="font-medium underline">
            {tr.errors.linkAccount}
          </Link>
        </InfoBanner>
      )}

      <PageTabs tabs={tabs} activeTab={tab} onTabChange={(id) => setTab(id as PullRequestTab)} />

      {tab === 'files' && (
        <FilesChanged
          pullRequestId={pr.id}
          canReview={canReview && pr.state === 'open'}
          drafts={drafts}
          onAddDraft={addDraft}
          onCommentNow={commentNow}
          onRemoveDraft={removeDraft}
          onReply={reply}
        />
      )}

      {tab === 'conversation' && (
        <Conversation pullRequestId={pr.id} canReview={canReview} onReply={reply} onComment={generalComment} />
      )}

      {tab === 'overview' && (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {canMerge && <MergeBox pullRequest={pr} merging={mergeOnProvider.isPending} onMerge={merge} />}
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
      )}

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
