import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Circle,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  Minus,
} from 'lucide-react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { cn } from '@weldsuite/ui/lib/utils';
import type {
  MergeChecksStatus,
  MergeIssuePriority,
  MergeIssueStatus,
  MergePullRequestState,
  MergeReviewDecision,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import { useI18n } from '@/lib/i18n/provider';
import { initials, providerMarkdown } from '../lib/format';
import { useMergeMembers } from '../lib/use-members';

const STATUS_ICON: Record<MergeIssueStatus, { icon: typeof Circle; className: string }> = {
  backlog: { icon: CircleDashed, className: 'text-muted-foreground' },
  todo: { icon: Circle, className: 'text-muted-foreground' },
  in_progress: { icon: CircleDot, className: 'text-amber-500' },
  in_review: { icon: CircleDot, className: 'text-violet-500' },
  done: { icon: CircleCheck, className: 'text-emerald-600' },
  canceled: { icon: CircleX, className: 'text-muted-foreground' },
};

/** The status of an issue as a coloured circle. */
export function IssueStatusIcon({ status, className }: Readonly<{ status: MergeIssueStatus; className?: string }>) {
  const { t } = useI18n();
  const { icon: Icon, className: tone } = STATUS_ICON[status];
  return <Icon className={cn('size-4 shrink-0', tone, className)} aria-label={t.weldmerge.status[status]} role="img" />;
}

const PRIORITY_BARS: Partial<Record<MergeIssuePriority, number>> = { 2: 3, 3: 2 };

/** Three bars filled by priority (urgent shows an alert), or a dash for none. */
export function PriorityBars({ priority, className }: Readonly<{ priority: MergeIssuePriority; className?: string }>) {
  const { t } = useI18n();
  const label = t.weldmerge.priority[priority];
  if (priority === 0) return <Minus className={cn('size-4 shrink-0 text-muted-foreground', className)} aria-label={label} role="img" />;
  if (priority === 1) return <AlertTriangle className={cn('size-4 shrink-0 text-orange-500', className)} aria-label={label} role="img" />;
  const filled = PRIORITY_BARS[priority] ?? 1;
  return (
    <span className={cn('inline-flex h-4 shrink-0 items-end gap-0.5', className)} role="img" aria-label={label}>
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={cn('w-[3px] rounded-sm', bar <= filled ? 'bg-foreground/70' : 'bg-muted-foreground/25')}
          style={{ height: `${bar * 4 + 2}px` }}
        />
      ))}
    </span>
  );
}

/** The state icon of a pull request. */
export function PullRequestStateIcon({
  state,
  draft,
  className,
}: Readonly<{ state: MergePullRequestState; draft?: boolean; className?: string }>) {
  const { t } = useI18n();
  if (state === 'merged') {
    return <GitMerge className={cn('size-4 shrink-0 text-violet-500', className)} aria-label={t.weldmerge.prState.merged} role="img" />;
  }
  if (state === 'closed') {
    return <GitPullRequestClosed className={cn('size-4 shrink-0 text-red-500', className)} aria-label={t.weldmerge.prState.closed} role="img" />;
  }
  if (draft) {
    return <GitPullRequestDraft className={cn('size-4 shrink-0 text-muted-foreground', className)} aria-label={t.weldmerge.prState.draft} role="img" />;
  }
  return <GitPullRequest className={cn('size-4 shrink-0 text-emerald-600', className)} aria-label={t.weldmerge.prState.open} role="img" />;
}

const PR_STATE_TONE: Record<MergePullRequestState, 'success' | 'danger' | 'neutral'> = {
  open: 'success',
  closed: 'danger',
  merged: 'neutral',
};

export function PullRequestStateBadge({ state, draft }: Readonly<{ state: MergePullRequestState; draft?: boolean }>) {
  const { t } = useI18n();
  if (state === 'open' && draft) return <SoftBadge tone="neutral">{t.weldmerge.prState.draft}</SoftBadge>;
  const tone = PR_STATE_TONE[state];
  return (
    <SoftBadge tone={tone} className={state === 'merged' ? 'border-transparent bg-violet-500/10 text-violet-600 dark:text-violet-400' : undefined}>
      {t.weldmerge.prState[state]}
    </SoftBadge>
  );
}

const CHECKS_ICON: Record<MergeChecksStatus | 'neutral', ReactNode> = {
  success: <CircleCheck className="size-4 text-emerald-600" />,
  failure: <CircleX className="size-4 text-red-500" />,
  pending: <Loader2 className="size-4 animate-spin text-amber-500" />,
  neutral: <Minus className="size-4 text-muted-foreground" />,
};

/** Whether the checks of a pull request passed, as an icon with the status in its label. */
export function ChecksIndicator({
  status,
  withLabel = false,
}: Readonly<{ status: MergeChecksStatus | null; withLabel?: boolean }>) {
  const { t } = useI18n();
  const key = status ?? 'neutral';
  const label = t.weldmerge.checks[key];
  const icon = CHECKS_ICON[key];
  return (
    <span className="inline-flex items-center gap-1.5" role="img" aria-label={label} title={label}>
      {icon}
      {withLabel && <span className="text-sm">{label}</span>}
    </span>
  );
}

const REVIEW_TONE: Record<MergeReviewDecision, 'success' | 'danger' | 'warning'> = {
  approved: 'success',
  changes_requested: 'danger',
  review_required: 'warning',
};

export function ReviewDecisionBadge({ decision }: Readonly<{ decision: MergeReviewDecision | null }>) {
  const { t } = useI18n();
  if (!decision) return <span className="text-sm text-muted-foreground">{t.weldmerge.none}</span>;
  const tone = REVIEW_TONE[decision];
  return <SoftBadge tone={tone}>{t.weldmerge.review[decision]}</SoftBadge>;
}

/** A coloured dot and a name, for labels. */
export function LabelChip({ name, color }: Readonly<{ name: string; color?: string | null }>) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color ?? '#94a3b8' }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A provider identity (git login with an avatar), for authors and reviewers. */
export function ProviderAvatar({
  login,
  avatarUrl,
  className,
}: Readonly<{ login: string | null; avatarUrl?: string | null; className?: string }>) {
  const name = login ?? '?';
  return (
    <Avatar className={cn('size-5', className)} title={name}>
      {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
      <AvatarFallback className="text-[10px]">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/** A workspace member by user id, resolved from the member directory. */
export function MemberAvatar({ userId, className }: Readonly<{ userId: string | null; className?: string }>) {
  const { memberById } = useMergeMembers();
  if (!userId) return null;
  const member = memberById.get(userId);
  return (
    <Avatar className={cn('size-5', className)} title={member?.name ?? userId}>
      {member?.picture && <AvatarImage src={member.picture} alt={member.name} />}
      <AvatarFallback className="text-[10px]">{initials(member?.name ?? userId)}</AvatarFallback>
    </Avatar>
  );
}

/** A workspace member's name, or a fallback while the directory loads. */
export function useMemberName(userId: string | null | undefined): string | null {
  const { memberById } = useMergeMembers();
  if (!userId) return null;
  return memberById.get(userId)?.name ?? null;
}

/** Renders Markdown (GitHub flavour); raw HTML is never rendered, and HTML comments not shown. */
export function MarkdownBody({ children, className }: Readonly<{ children: string; className?: string }>) {
  return (
    <div className={cn('prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{providerMarkdown(children)}</ReactMarkdown>
    </div>
  );
}
