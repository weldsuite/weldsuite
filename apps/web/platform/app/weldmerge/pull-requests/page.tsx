import { useMemo, useState, type ReactNode } from 'react';
import { GitPullRequest, Loader2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import {
  MERGE_PULL_REQUEST_VIEWS,
  type MergePullRequestListItem,
  type MergePullRequestView,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useObjectPanel,
  useObjectPanelNavigationSource,
  useObjectPanelUrlSync,
} from '@/components/object-panel';
import { useDebounce } from '@/hooks/use-debounce';
import {
  useMergePullRequests,
  useMergeRepositories,
  useMergeTeams,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { ChecksIndicator, ProviderAvatar, PullRequestStateIcon } from '../components/primitives';
import { fill, relativeTime } from '../lib/format';
import { MERGE_PULL_REQUEST_PANEL_TYPE } from './pull-request-panel-type';

/**
 * Pull requests from every tracked repository, in five views: needs my review,
 * mine, open, merged, closed. A row opens the pull request in the record panel
 * (`?stack=merge_pull_request:<id>`), with previous / next through the list.
 */
export default function WeldMergePullRequestsPage() {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldmerge/pull-requests');
  const canReadConnections = useCan('merge_connections:read');

  const [view, setView] = useState<MergePullRequestView>('needs_review');
  const [repositoryId, setRepositoryId] = useState<string | undefined>();
  const [teamId, setTeamId] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim(), 300) || undefined;

  const pullRequests = useMergePullRequests({ view, repositoryId, teamId, q });
  const repositories = useMergeRepositories(canReadConnections);
  const teams = useMergeTeams();

  const rows = useMemo(() => pullRequests.data ?? [], [pullRequests.data]);
  useObjectPanelNavigationSource({
    type: MERGE_PULL_REQUEST_PANEL_TYPE,
    ids: rows.map((pr) => pr.id),
    hasMore: pullRequests.hasNextPage,
    loadMore: () => pullRequests.fetchNextPage(),
  });

  const tabs: PageTab[] = MERGE_PULL_REQUEST_VIEWS.map((id) => ({ id, label: tm.pullRequests.views[id] }));

  const columns: ListTableColumn<MergePullRequestListItem>[] = [
    {
      id: 'title',
      header: tm.pullRequests.columns.title,
      className: 'flex-1 min-w-[16rem]',
      cell: (pr) => (
        <div className="flex min-w-0 items-center gap-2">
          <PullRequestStateIcon state={pr.state} draft={pr.draft} />
          <span className="truncate text-sm font-medium">{pr.title}</span>
          {pr.draft && <SoftBadge tone="neutral">{tm.pullRequests.draftBadge}</SoftBadge>}
        </div>
      ),
    },
    {
      id: 'repository',
      header: tm.pullRequests.columns.repository,
      width: 'w-[14rem]',
      className: 'hidden lg:flex',
      cell: (pr) => (
        <span className="truncate text-sm text-muted-foreground">
          {pr.repositoryFullName} #{pr.number}
        </span>
      ),
    },
    {
      id: 'issue',
      header: tm.pullRequests.columns.issue,
      width: 'w-[8rem]',
      className: 'hidden md:flex',
      cell: (pr) =>
        pr.issues.length === 0 ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {pr.issues.map((issue) => (
              <Link
                key={issue.id}
                href={`/weldmerge/issues/${issue.key}`}
                className="relative z-[1] rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
              >
                {issue.key}
              </Link>
            ))}
          </div>
        ),
    },
    {
      id: 'checks',
      header: tm.pullRequests.columns.checks,
      width: 'w-[5rem]',
      className: 'hidden md:flex',
      cell: (pr) => <ChecksIndicator status={pr.checksStatus} />,
    },
    {
      id: 'reviewers',
      header: tm.pullRequests.columns.reviewers,
      width: 'w-[7rem]',
      className: 'hidden xl:flex',
      cell: (pr) => (
        <div className="flex -space-x-1.5">
          {pr.requestedReviewers.slice(0, 3).map((reviewer) => (
            <ProviderAvatar key={`${reviewer.kind}:${reviewer.login}`} login={reviewer.login} avatarUrl={reviewer.avatarUrl} />
          ))}
        </div>
      ),
    },
    {
      id: 'changes',
      header: tm.pullRequests.columns.changes,
      width: 'w-[7rem]',
      className: 'hidden lg:flex',
      cell: (pr) => (
        <span className="text-sm tabular-nums" title={fill(tm.changes, { additions: pr.additions ?? 0, deletions: pr.deletions ?? 0 })}>
          <span className="text-emerald-600">+{pr.additions ?? 0}</span>{' '}
          <span className="text-red-500">−{pr.deletions ?? 0}</span>
        </span>
      ),
    },
    {
      id: 'author',
      header: tm.pullRequests.columns.author,
      width: 'w-[3rem]',
      className: 'hidden sm:flex',
      cell: (pr) => <ProviderAvatar login={pr.authorLogin} avatarUrl={pr.authorAvatarUrl} />,
    },
    {
      id: 'updated',
      header: tm.pullRequests.columns.updated,
      width: 'w-[5rem]',
      align: 'right',
      cell: (pr) => (
        <span className="text-xs text-muted-foreground">{relativeTime(pr.providerUpdatedAt, language, tm.justNow)}</span>
      ),
    },
  ];

  const noRepositories = canReadConnections && repositories.isSuccess && repositories.data.length === 0;
  const filtered = !!(repositoryId || teamId || q);

  let content: ReactNode;
  if (pullRequests.isLoading) {
    content = <PageLoader fullScreen={false} />;
  } else if (pullRequests.isError) {
    content = <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void pullRequests.refetch()} />;
  } else if (noRepositories && rows.length === 0) {
    content = (
      <div className="p-6">
        <EmptyState
          icon={GitPullRequest}
          title={tm.pullRequests.noRepositoriesTitle}
          description={tm.pullRequests.noRepositoriesDescription}
          action={
            <Button asChild>
              <Link href="/weldmerge/settings">{tm.pullRequests.openProviders}</Link>
            </Button>
          }
        />
      </div>
    );
  } else {
    content = (
      <>
        <ListTable
          columns={columns}
          data={rows}
          rowKey={(pr) => pr.id}
          rowLabel={(pr) => pr.title}
          onRowClick={(pr) => openPanel({ type: MERGE_PULL_REQUEST_PANEL_TYPE, id: pr.id })}
          emptyState={{
            icon: <GitPullRequest className="size-8 text-muted-foreground/60" />,
            title: filtered ? tm.pullRequests.noResultsTitle : tm.pullRequests.emptyTitle,
            description: tm.pullRequests.emptyDescription,
          }}
        />
        {pullRequests.hasNextPage && (
          <div className="flex justify-center p-4">
            <Button variant="outline" onClick={() => void pullRequests.fetchNextPage()} disabled={pullRequests.isFetchingNextPage}>
              {pullRequests.isFetchingNextPage && <Loader2 className="animate-spin" />}
              {tm.loadMore}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 px-4 pt-3">
        <div>
          <h1 className="text-lg font-semibold">{tm.pullRequests.title}</h1>
          <p className="text-sm text-muted-foreground">{tm.pullRequests.description}</p>
        </div>
        <PageTabs tabs={tabs} activeTab={view} onTabChange={(id) => setView(id as MergePullRequestView)} />
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tm.pullRequests.searchPlaceholder}
            aria-label={tm.pullRequests.searchPlaceholder}
            className="w-56"
          />
          {canReadConnections && (
            <FilterSelect
              value={repositoryId}
              onChange={setRepositoryId}
              ariaLabel={tm.pullRequests.repository}
              allLabel={tm.pullRequests.allRepositories}
              options={(repositories.data ?? []).map((repo) => ({ value: repo.id, label: repo.fullName }))}
            />
          )}
          <FilterSelect
            value={teamId}
            onChange={setTeamId}
            ariaLabel={tm.pullRequests.team}
            allLabel={tm.pullRequests.allTeams}
            options={(teams.data ?? []).map((team) => ({ value: team.id, label: team.name }))}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {content}
      </div>
    </div>
  );
}
