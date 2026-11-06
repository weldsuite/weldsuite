import { useMemo, useState, type ReactNode } from 'react';
import { BellOff, Check, GitMerge, GitPullRequest, Inbox, Loader2, Rocket, ShieldAlert, SquareCheckBig, SquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import type { MergeChatCardMetadata } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { ChecksIndicator, IssueStatusIcon, PullRequestStateBadge } from '@/app/weldmerge/components/primitives';
import { fill } from '@/app/weldmerge/lib/format';
import { useApproveMergePullRequest, useMergeRelease } from '@/hooks/queries/use-weldmerge-across-queries';
import { useUpdateMergeInboxItem } from '@/hooks/queries/use-weldmerge-sync-queries';
import { useMergeIssue, useMergePullRequest } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { cardSubject, offersReviewActions, readWeldMergeCard, type WeldMergeCardSubject } from '../lib/weldmerge-card';

const KIND_ICON = {
  review_requested: GitPullRequest,
  checks_failed: ShieldAlert,
  pull_request_merged: GitMerge,
  issue_created: SquarePlus,
  issue_done: SquareCheckBig,
  release_shipped: Rocket,
  daily_digest: Inbox,
  shared_issue: SquareCheckBig,
  shared_pull_request: GitPullRequest,
} as const;

const KIND_TONE: Partial<Record<MergeChatCardMetadata['kind'], string>> = {
  checks_failed: 'border-destructive/30 bg-destructive/[0.04]',
  review_requested: 'border-amber-500/30 bg-amber-500/[0.04]',
  pull_request_merged: 'border-violet-500/30 bg-violet-500/[0.04]',
  release_shipped: 'border-emerald-500/30 bg-emerald-500/[0.04]',
};

function CardFrame({
  card,
  children,
  actions,
}: Readonly<{ card: MergeChatCardMetadata; children: ReactNode; actions?: ReactNode }>) {
  const { t } = useI18n();
  const Icon = KIND_ICON[card.kind];
  return (
    <div
      data-testid="chat-message-weldmerge-card"
      data-card-kind={card.kind}
      className={cn('flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm', KIND_TONE[card.kind])}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">{t.weldmerge.across.chat.kind[card.kind]}</p>
        {children}
      </div>
      {actions && <div className="flex shrink-0 gap-1.5">{actions}</div>}
    </div>
  );
}

function Unavailable({ card }: Readonly<{ card: MergeChatCardMetadata }>) {
  const { t } = useI18n();
  return (
    <CardFrame card={card}>
      <p className="text-muted-foreground">{t.weldmerge.across.chat.notFound}</p>
    </CardFrame>
  );
}

function IssueCard({ card, issueId }: Readonly<{ card: MergeChatCardMetadata; issueId: string }>) {
  const { t } = useI18n();
  const query = useMergeIssue(issueId);
  const issue = query.data;
  if (query.isLoading) return <CardFrame card={card}><Loader2 className="size-4 animate-spin text-muted-foreground" /></CardFrame>;
  if (!issue) return <Unavailable card={card} />;
  return (
    <CardFrame
      card={card}
      actions={
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
          <Link href={`/weldmerge/issues/${issue.key}`}>{t.weldmerge.across.chat.open}</Link>
        </Button>
      }
    >
      <p className="flex items-center gap-2">
        <IssueStatusIcon status={issue.status} />
        <span className="shrink-0 text-xs text-muted-foreground">{issue.key}</span>
        <span className="min-w-0 truncate font-medium">{issue.title}</span>
      </p>
    </CardFrame>
  );
}

function PullRequestCard({ card, pullRequestId }: Readonly<{ card: MergeChatCardMetadata; pullRequestId: string }>) {
  const { t } = useI18n();
  const tc = t.weldmerge.across.chat;
  const query = useMergePullRequest(pullRequestId);
  const canReview = useCan('merge_pull_requests:review');
  const canRead = useCan('merge_pull_requests:read');
  const approve = useApproveMergePullRequest();
  const inbox = useUpdateMergeInboxItem();
  const [approved, setApproved] = useState(false);
  const [snoozed, setSnoozed] = useState(false);
  const pr = query.data;

  const doApprove = async () => {
    try {
      await approve.mutateAsync({ id: pullRequestId });
      setApproved(true);
    } catch (err) {
      toast.error(isApiError(err) && err.status === 409 ? tc.notLinked : tc.approveFailed);
    }
  };

  const doSnooze = async () => {
    if (!card.itemKey) return;
    // Until the same time tomorrow.
    const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    try {
      await inbox.mutateAsync({ itemKey: card.itemKey, input: { snoozedUntil: until } });
      setSnoozed(true);
      toast.success(tc.snoozed);
    } catch {
      toast.error(tc.snoozeFailed);
    }
  };

  if (query.isLoading) return <CardFrame card={card}><Loader2 className="size-4 animate-spin text-muted-foreground" /></CardFrame>;
  if (!pr) return <Unavailable card={card} />;

  const reviewActions = offersReviewActions(card.kind) && pr.state === 'open';
  let approveIcon: ReactNode = null;
  if (approved) approveIcon = <Check />;
  else if (approve.isPending) approveIcon = <Loader2 className="animate-spin" />;
  const actions = (
    <>
      {reviewActions && canRead && card.itemKey && !snoozed && (
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={inbox.isPending} onClick={() => void doSnooze()}>
          <BellOff />
          {tc.snooze}
        </Button>
      )}
      {reviewActions && canReview && (
        <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={approve.isPending || approved} onClick={() => void doApprove()}>
          {approveIcon}
          {approved ? tc.approved : tc.approve}
        </Button>
      )}
      <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
        <Link href={`/weldmerge/pull-requests/${pr.id}`}>{tc.open}</Link>
      </Button>
    </>
  );

  return (
    <CardFrame card={card} actions={actions}>
      <p className="truncate font-medium">{pr.title}</p>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {pr.repositoryFullName} #{pr.number}
        </span>
        <PullRequestStateBadge state={pr.state} draft={pr.draft} />
        <ChecksIndicator status={pr.checksStatus} />
      </p>
    </CardFrame>
  );
}

function ReleaseCard({ card, releaseId }: Readonly<{ card: MergeChatCardMetadata; releaseId: string }>) {
  const { t } = useI18n();
  const query = useMergeRelease(releaseId);
  const release = query.data;
  if (query.isLoading) return <CardFrame card={card}><Loader2 className="size-4 animate-spin text-muted-foreground" /></CardFrame>;
  if (!release) return <Unavailable card={card} />;
  return (
    <CardFrame
      card={card}
      actions={
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
          <Link href={`/weldmerge/releases/${release.id}`}>{t.weldmerge.across.chat.open}</Link>
        </Button>
      }
    >
      <p className="truncate font-medium">
        {release.name}
        {release.version ? ` ${release.version}` : ''}
      </p>
      <p className="text-xs text-muted-foreground">
        {release.repositoryFullName} · {fill(t.weldmerge.across.chat.shippedPullRequests, { count: release.pullRequestCount })}
      </p>
    </CardFrame>
  );
}

function DigestCard({ card }: Readonly<{ card: MergeChatCardMetadata }>) {
  const { t } = useI18n();
  return (
    <CardFrame
      card={card}
      actions={
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
          <Link href="/weldmerge">{t.weldmerge.across.chat.digestOpen}</Link>
        </Button>
      }
    >
      <p className="text-muted-foreground">{t.weldmerge.across.chat.kind.daily_digest}</p>
    </CardFrame>
  );
}

interface MessageWeldMergeCardProps {
  message: object;
}

/** The card for a subject the viewer may read; the card holds ids only, so what they may not read is not fetched. */
function CardGate({ card, subject }: Readonly<{ card: MergeChatCardMetadata; subject: WeldMergeCardSubject }>) {
  const canRead = useCan('merge_issues:read');
  const canReadPullRequests = useCan('merge_pull_requests:read');
  const canReadReleases = useCan('merge_releases:read');
  if (subject.type === 'issue' && !canRead) return null;
  if (subject.type === 'release' && !canReadReleases) return null;
  if ((subject.type === 'pull_request' || subject.type === 'digest') && !canReadPullRequests) return null;

  let body: ReactNode;
  switch (subject.type) {
    case 'issue':
      body = <IssueCard card={card} issueId={subject.id} />;
      break;
    case 'pull_request':
      body = <PullRequestCard card={card} pullRequestId={subject.id} />;
      break;
    case 'release':
      body = <ReleaseCard card={card} releaseId={subject.id} />;
      break;
    default:
      body = <DigestCard card={card} />;
  }
  return <div className="mt-2">{body}</div>;
}

/**
 * The card under a message WeldMerge posted (review request, failed checks,
 * merged pull request, issue created or done, shipped release, daily digest) or
 * a member shared with /merge. Renders nothing for any other message, and
 * touches no provider until a message has a card.
 */
export function MessageWeldMergeCard({ message }: Readonly<MessageWeldMergeCardProps>) {
  const card = useMemo(() => readWeldMergeCard((message as { metadata?: unknown }).metadata), [message]);
  const subject = card ? cardSubject(card) : null;
  if (!card || !subject) return null;
  return <CardGate card={card} subject={subject} />;
}
