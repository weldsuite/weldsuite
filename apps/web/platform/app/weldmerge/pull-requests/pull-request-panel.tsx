/**
 * A pull request as a record panel, on the same shell as the company and
 * person panels: `useObjectPanelShell` + `EntityDetailView` + `PropertyRow`s,
 * so it opens over the list like every record (side panel or fullscreen,
 * previous / next, back). The old `/weldmerge/pull-requests/:id` URL redirects
 * to the list with this panel open in fullscreen.
 *
 * Tabs, each its own body like a company's tabs: Details (state, branches,
 * review, checks, reviewers, labels, sync, and under them the provider's
 * comments and review threads with the chat composer) · Description · Files
 * changed (the diff with inline review threads) · Issues (linked issues, like a
 * company's People) · Merge (while open, for members who may merge). No
 * sidebar: the provider's conversation is part of Details, not a chat. Members with `merge_pull_requests:review` review and comment as their
 * own linked provider account, with `:merge` they merge; members who can
 * update issues link and unlink them.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  ChartNoAxesGantt,
  CircleDot,
  Clock,
  EllipsisVertical,
  ExternalLink,
  FileDiff,
  FileText,
  Flag,
  FolderGit2,
  GitBranch,
  GitMerge,
  Link as LinkIcon,
  ListChecks,
  RefreshCw,
  Tag,
  Unlink,
  User,
  UserCheck,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCan } from '@weldsuite/permissions/react';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import type { MergeIssueLink, MergePullRequestDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeMethod, MergeReviewEvent, MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import {
  ObjectPanelTabs,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityList, type ActiveFilter, type FilterConfig, type HeaderColumn } from '@/components/entity-list';
import { LinkedRecordStatus } from '@/components/objects/_shared/linked-record-row';
import {
  PanelNotice,
  PanelRow,
  RecordLoadFailed,
  useCopyPanelLink,
} from '@/components/objects/_shared/record-panel-parts';
import {
  IssuesIllustration,
  NotesIllustration,
  TAB_EMPTY_STATE_TABLE_CLASS,
  TabEmptyState,
  tabBodyClassName,
} from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { usePanelInitialTab } from '@/components/objects/_shared/use-panel-initial-tab';
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
import { applySelectFilters } from '@/lib/list-filters';
import { Link, useRouter } from '@/lib/router';
import type { DraftComment } from '../components/diff/file-diff';
import { FilesChanged } from '../components/diff/files-changed';
import { LinkIssuePopover } from '../components/link-issue-popover';
import { Conversation } from '../components/review/conversation';
import { MergeBox } from '../components/review/merge-box';
import { ReviewPopover } from '../components/review/review-popover';
import {
  ChecksIndicator,
  IssueStatusIcon,
  LabelChip,
  MarkdownBody,
  ProviderAvatar,
  PullRequestStateBadge,
  PullRequestStateIcon,
  ReviewDecisionBadge,
} from '../components/primitives';
import { fill, relativeTime } from '../lib/format';
import { weldmergeSettingsTab } from '../lib/settings-path';
import { MERGE_PULL_REQUEST_PANEL_TYPE } from './pull-request-panel-type';

/** The width every record panel opens at, so a pull request takes the same room as a company. */
const PULL_REQUEST_PANEL_WIDTH = 400;

type PullRequestTab = 'overview' | 'description' | 'files' | 'issues' | 'merge';

let draftSequence = 0;

// ─── Header ────────────────────────────────────────────────────────────────

/** The record avatar (the company's 22px tile), showing the pull request's state where a company shows its logo. */
function PullRequestAvatar({ pr }: Readonly<{ pr?: MergePullRequestDetailDto }>) {
  if (!pr) return <div className="size-[22px] rounded-[32%] bg-muted animate-pulse" />;
  return (
    <Avatar className="size-[22px]">
      <AvatarFallback className="bg-muted">
        <PullRequestStateIcon state={pr.state} draft={pr.draft} className="size-3.5" />
      </AvatarFallback>
    </Avatar>
  );
}

function PullRequestTitle({ pr }: Readonly<{ pr?: MergePullRequestDetailDto }>) {
  if (!pr) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <span className="block truncate text-[15px] font-medium leading-6 text-foreground">
      {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
    </span>
  );
}

/** The header actions: Review changes, and the kebab with the provider link and the copy-link action. */
function PullRequestActions({
  pr,
  canReview,
  pendingCount,
  submitting,
  onReview,
}: Readonly<{
  pr?: MergePullRequestDetailDto;
  canReview: boolean;
  pendingCount: number;
  submitting: boolean;
  onReview: (event: MergeReviewEvent, body: string) => Promise<void>;
}>) {
  const { t } = useI18n();
  const st = useTranslations();
  const copyLink = useCopyPanelLink('/weldmerge/pull-requests', MERGE_PULL_REQUEST_PANEL_TYPE, pr?.id ?? '');
  if (!pr) return null;
  const provider = t.weldmerge.provider[pr.provider];

  // Same 28px buttons as the shell's Expand / Close, returned as a fragment so
  // the shell's own spacing applies between every header button.
  return (
    <>
      {canReview && pr.state === 'open' && (
        <ReviewPopover pendingCount={pendingCount} submitting={submitting} onSubmit={onReview} />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={st('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a href={pr.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              {fill(t.weldmerge.openOnProvider, { provider })}
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// ─── Details body ──────────────────────────────────────────────────────────

function PullRequestProperties({ pr }: Readonly<{ pr: MergePullRequestDetailDto }>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tp = tm.pullRequests;
  const stateLabel = pr.state === 'open' && pr.draft ? tm.prState.draft : tm.prState[pr.state];
  const changes = fill(tm.changes, { additions: pr.additions ?? 0, deletions: pr.deletions ?? 0 });

  return (
    <div className="space-y-1">
      <PanelRow
        icon={Flag}
        label={tp.state}
        value={stateLabel}
        renderValue={() => <PullRequestStateBadge state={pr.state} draft={pr.draft} />}
      />
      <PanelRow
        icon={FolderGit2}
        label={tp.repository}
        value={`${tm.provider[pr.provider]} · ${pr.repositoryFullName}`}
      />
      <PanelRow
        icon={User}
        label={tp.author}
        value={pr.authorLogin}
        renderValue={(login) => (
          <span className="flex min-w-0 items-center gap-2">
            <ProviderAvatar login={login ?? null} avatarUrl={pr.authorAvatarUrl} />
            <span className="truncate">{login}</span>
          </span>
        )}
      />
      <PanelRow
        icon={GitBranch}
        label={tp.branch}
        value={pr.headRef}
        renderValue={(head) => (
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            <code className="rounded bg-muted px-1 text-xs">{head}</code>
            {pr.baseRef && (
              <>
                {' → '}
                <code className="rounded bg-muted px-1 text-xs">{pr.baseRef}</code>
              </>
            )}
          </span>
        )}
      />
      <PanelRow
        icon={UserCheck}
        label={tp.reviewDecision}
        value={pr.reviewDecision ? tm.review[pr.reviewDecision] : null}
        renderValue={() => <ReviewDecisionBadge decision={pr.reviewDecision} />}
      />
      <PanelRow
        icon={ListChecks}
        label={tp.checksTitle}
        value={tm.checks[pr.checksStatus ?? 'neutral']}
        renderValue={() => <ChecksIndicator status={pr.checksStatus} withLabel />}
      />
      <PanelRow
        icon={FileDiff}
        label={tp.columns.changes}
        value={changes}
        renderValue={() => (
          <span className="tabular-nums" title={changes}>
            <span className="text-emerald-600">+{pr.additions ?? 0}</span>{' '}
            <span className="text-red-500">−{pr.deletions ?? 0}</span>
            {pr.changedFiles !== null && (
              <span className="text-muted-foreground"> · {fill(tm.filesChanged, { count: pr.changedFiles })}</span>
            )}
          </span>
        )}
      />
      <PanelRow
        icon={Users}
        label={tm.reviewers}
        value={pr.requestedReviewers.map((reviewer) => reviewer.login).join(', ') || null}
        renderValue={() => (
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {pr.requestedReviewers.map((reviewer) => (
              <span key={`${reviewer.kind}:${reviewer.login}`} className="flex items-center gap-1.5">
                <ProviderAvatar login={reviewer.login} avatarUrl={reviewer.avatarUrl} />
                {reviewer.login}
              </span>
            ))}
          </span>
        )}
      />
      <PanelRow
        icon={Tag}
        label={tp.labels}
        value={pr.labels.map((label) => label.name).join(', ') || null}
        renderValue={() => (
          <span className="flex min-w-0 flex-wrap gap-1.5">
            {pr.labels.map((label) => (
              <LabelChip key={label.name} name={label.name} color={label.color} />
            ))}
          </span>
        )}
      />
      <PanelRow
        icon={Clock}
        label={tp.columns.updated}
        value={relativeTime(pr.providerUpdatedAt, language, tm.justNow)}
      />
      <PanelRow icon={RefreshCw} label={tp.synced} value={relativeTime(pr.syncedAt, language, tm.justNow)} />
    </div>
  );
}

// ─── Issues tab ────────────────────────────────────────────────────────────

const ISSUE_STATUS_TONE: Record<MergeIssueLink['status'], 'blue' | 'green' | 'amber' | 'gray'> = {
  backlog: 'gray',
  todo: 'gray',
  in_progress: 'amber',
  in_review: 'blue',
  done: 'green',
  canceled: 'gray',
};

const ISSUE_STATUSES: MergeIssueLink['status'][] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'];

const ISSUE_COLUMN = {
  name: 'min-w-0 flex-1',
  status: 'w-[130px] @max-[560px]:hidden',
};

/**
 * The issues linked to the pull request, as a company's People tab lists its
 * people: the standard `EntityList` with a search, the link action and rows
 * that open the issue, and the illustrated empty state.
 */
function PullRequestIssuesTab({
  pr,
  canUpdate,
  linking,
  onLink,
  onUnlink,
}: Readonly<{
  pr: MergePullRequestDetailDto;
  canUpdate: boolean;
  linking: boolean;
  onLink: (issueId: string) => void;
  onUnlink: (issue: MergeIssueLink) => void;
}>) {
  const { t } = useI18n();
  const st = useTranslations();
  const tm = t.weldmerge;
  const tp = tm.pullRequests;
  const router = useRouter();
  const [linkOpen, setLinkOpen] = useState(false);

  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'name', header: tp.columns.issue, width: ISSUE_COLUMN.name },
      { id: 'status', header: st('sweep.entities.fieldStatus'), width: ISSUE_COLUMN.status },
    ],
    [st, tp.columns.issue],
  );

  const filterConfigs = useMemo<FilterConfig[]>(
    () => [
      {
        field: 'status',
        label: st('sweep.entities.fieldStatus'),
        options: ISSUE_STATUSES.map((status) => ({ value: status, label: tm.status[status] })),
      },
    ],
    [st, tm.status],
  );

  const applyFilters = useCallback(
    (list: MergeIssueLink[], filters: ActiveFilter[]) =>
      applySelectFilters(list, filters, { status: (issue, value) => issue.status === value }),
    [],
  );

  const renderRow = useCallback(
    (issue: MergeIssueLink) => (
      <TabListRow
        key={issue.id}
        label={`${issue.key} ${issue.title}`}
        onOpen={() => router.push(`/weldmerge/issues/${issue.key}`)}
        menuLabel={st('sweep.entities.moreActions')}
        menu={
          canUpdate ? (
            <DropdownMenuItem variant="destructive" onClick={() => onUnlink(issue)}>
              <Unlink />
              {tp.unlink}
            </DropdownMenuItem>
          ) : undefined
        }
      >
        <div className={`${ISSUE_COLUMN.name} flex items-center gap-2`}>
          <IssueStatusIcon status={issue.status} />
          <span className="shrink-0 text-sm text-muted-foreground">{issue.key}</span>
          <span className="truncate text-sm font-medium text-foreground">{issue.title}</span>
          {issue.closes && <LinkedRecordStatus tone="blue">{tp.closesIssue}</LinkedRecordStatus>}
        </div>
        <div className={`${ISSUE_COLUMN.status} flex min-w-0 items-center`}>
          <LinkedRecordStatus tone={ISSUE_STATUS_TONE[issue.status]}>{tm.status[issue.status]}</LinkedRecordStatus>
        </div>
      </TabListRow>
    ),
    [canUpdate, onUnlink, router, st, tm.status, tp.closesIssue, tp.unlink],
  );

  return (
    <TabListScope>
      <EntityList<MergeIssueLink>
        items={pr.issues}
        isLoading={false}
        error={null}
        filters={filterConfigs}
        applyFilters={applyFilters}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={tp.linkIssueSearch}
        searchFields={['key', 'title']}
        actionButtons={
          canUpdate ? (
            <LinkIssuePopover
              excludeIds={pr.issues.map((issue) => issue.id)}
              pending={linking}
              onPick={onLink}
              open={linkOpen}
              onOpenChange={setLinkOpen}
            />
          ) : undefined
        }
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{
          icon: <IssuesIllustration />,
          title: tm.noLinkedIssues,
          description: tp.noLinkedIssuesDescription,
          ...(canUpdate ? { action: { label: tp.linkIssue, onClick: () => setLinkOpen(true) } } : {}),
        }}
        noResultsState={{
          title: tp.issuesNoResultsTitle,
          description: tp.issuesNoResultsDescription,
        }}
      />
    </TabListScope>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function PullRequestPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const tm = t.weldmerge;
  const tp = tm.pullRequests;
  const tr = tm.reviewing;

  const query = useMergePullRequest(id);
  const pr = query.data;
  const link = useLinkMergePullRequest();
  const unlink = useUnlinkMergePullRequest();
  const canUpdateIssues = useCan('merge_issues:update');
  const canReview = useCan('merge_pull_requests:review');
  const canMerge = useCan('merge_pull_requests:merge');
  const submitReview = useSubmitMergeReview(id);
  const createComment = useCreateMergePullRequestComment(id);
  const mergeOnProvider = useMergePullRequestOnProvider(id);
  const [unlinking, setUnlinking] = useState<MergeIssueLink | null>(null);
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [notLinked, setNotLinked] = useState(false);

  const shell = useObjectPanelShell({
    ...props,
    width: PULL_REQUEST_PANEL_WIDTH,
    loading: query.isLoading && !pr,
  });
  const mode = shell.mode;

  const tabs = useMemo<{ id: PullRequestTab; label: string; icon: typeof ChartNoAxesGantt; count?: number }[]>(
    () => [
      // The company panel's Details icon, so the tab reads the same on every record.
      { id: 'overview', label: st('sweep.entities.detailsTab'), icon: ChartNoAxesGantt },
      { id: 'description', label: tr.tabs.description, icon: FileText },
      { id: 'files', label: tr.tabs.files, icon: FileDiff, count: pr?.changedFiles ?? undefined },
      { id: 'issues', label: tr.tabs.issues, icon: CircleDot, count: pr?.issues.length || undefined },
      // Merging is only offered while it can happen, to members who may do it.
      ...(canMerge && pr?.state === 'open' ? [{ id: 'merge' as const, label: tr.tabs.merge, icon: GitMerge }] : []),
    ],
    [st, tr.tabs, pr?.changedFiles, pr?.issues.length, pr?.state, canMerge],
  );
  const [chosenTab, setActiveTab] = usePanelInitialTab<PullRequestTab>(tabs, initialTab, 'overview');
  // A tab that went away (Merge, once the pull request is merged) falls back to Details.
  const activeTab: PullRequestTab = tabs.some((tab) => tab.id === chosenTab) ? chosenTab : 'overview';

  const provider = pr ? tm.provider[pr.provider] : '';
  const notFound = query.isError && isApiError(query.error) && query.error.status === 404;

  const handleLink = async (issueId: string) => {
    try {
      await link.mutateAsync({ issueId, input: { pullRequestId: id, closes: true } });
    } catch {
      toast.error(tp.linkFailed);
    }
  };

  const handleUnlink = async () => {
    if (!unlinking) return;
    try {
      await unlink.mutateAsync({ issueId: unlinking.id, pullRequestId: id });
      setUnlinking(null);
    } catch {
      toast.error(tp.unlinkFailed);
    }
  };

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
  const removeDraft = (draftId: string) => setDrafts((current) => current.filter((draft) => draft.id !== draftId));

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

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(mode)}
        avatar={<PullRequestAvatar pr={pr} />}
        title={<PullRequestTitle pr={pr} />}
        actions={
          <PullRequestActions
            pr={pr}
            canReview={canReview}
            pendingCount={drafts.length}
            submitting={submitReview.isPending}
            onReview={review}
          />
        }
        subheader={
          notLinked ? (
            <div className="px-4 pt-3">
              <InfoBanner variant="warning">
                {fill(tr.errors.accountNotLinked, { provider })}{' '}
                <Link href={weldmergeSettingsTab('accounts')} className="font-medium underline">
                  {tr.errors.linkAccount}
                </Link>
              </InfoBanner>
            </div>
          ) : undefined
        }
        tabs={<ObjectPanelTabs tabs={tabs} activeTab={activeTab} onChange={(tabId) => setActiveTab(tabId as PullRequestTab)} />}
      >
        {!query.isLoading && !pr ? (
          <RecordLoadFailed
            notFound={notFound}
            message={notFound ? tp.notFound : tm.loadFailed}
            retryLabel={tm.retry}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {pr && activeTab === 'overview' && (
          <div className="flex min-h-full flex-col">
            <div className="space-y-4 p-4">
              {!canReview && !canMerge && <PanelNotice>{tp.readOnlyNote}</PanelNotice>}
              <PullRequestProperties pr={pr} />
            </div>
            <Conversation pullRequestId={id} canReview={canReview} onReply={reply} onComment={generalComment} />
          </div>
        )}

        {pr && activeTab === 'description' &&
          (pr.body ? (
            <div className="p-4">
              <MarkdownBody>{pr.body}</MarkdownBody>
            </div>
          ) : (
            <TabEmptyState illustration={<NotesIllustration />} title={tp.noDescriptionTitle} description={tp.noDescriptionDescription} bare />
          ))}

        {pr && activeTab === 'issues' && (
          <PullRequestIssuesTab
            pr={pr}
            canUpdate={canUpdateIssues}
            linking={link.isPending}
            onLink={(issueId) => void handleLink(issueId)}
            onUnlink={setUnlinking}
          />
        )}

        {pr && activeTab === 'merge' && (
          <div className="p-4">
            <MergeBox pullRequest={pr} merging={mergeOnProvider.isPending} onMerge={merge} />
          </div>
        )}

        {pr && activeTab === 'files' && (
          <div className="@container h-full">
            <FilesChanged
              pullRequestId={id}
              canReview={canReview && pr.state === 'open'}
              drafts={drafts}
              onAddDraft={addDraft}
              onCommentNow={commentNow}
              onRemoveDraft={removeDraft}
              onReply={reply}
            />
          </div>
        )}
      </EntityDetailView>

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
    </>
  );
}
