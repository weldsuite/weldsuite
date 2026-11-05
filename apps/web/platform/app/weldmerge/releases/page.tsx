import { useState, type ReactNode } from 'react';
import { Plus, Rocket } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { MergeReleaseDto, MergeReleaseStatus } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { useMergeReleases } from '@/hooks/queries/use-weldmerge-across-queries';
import { useMergeRepositories, useMergeTeams } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { fill, relativeTime } from '../lib/format';
import { ReleaseFormDialog } from './release-form-dialog';

type View = 'all' | MergeReleaseStatus;

/** Releases across the workspace's repositories: drafts being assembled and shipped ones. */
export default function WeldMergeReleasesPage() {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tr = tm.across.releases;
  const router = useRouter();
  const canManage = useCan('merge_releases:manage');
  const canReadConnections = useCan('merge_connections:read');

  const [view, setView] = useState<View>('all');
  const [creating, setCreating] = useState(false);

  const releases = useMergeReleases(view === 'all' ? {} : { status: view });
  const teams = useMergeTeams();
  const repositories = useMergeRepositories(canReadConnections || canManage);
  const rows = releases.data ?? [];
  const noRepositories = repositories.isSuccess && repositories.data.length === 0;

  const tabs: PageTab[] = [
    { id: 'all', label: tr.tabs.all },
    { id: 'draft', label: tr.tabs.draft },
    { id: 'shipped', label: tr.tabs.shipped },
  ];

  const columns: ListTableColumn<MergeReleaseDto>[] = [
    {
      id: 'name',
      header: tr.columns.name,
      className: 'flex-1 min-w-[14rem]',
      cell: (release) => (
        <div className="flex min-w-0 items-center gap-2">
          <Rocket className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{release.name}</span>
          {release.version && <span className="shrink-0 text-xs text-muted-foreground">{release.version}</span>}
        </div>
      ),
    },
    {
      id: 'repository',
      header: tr.columns.repository,
      width: 'w-[14rem]',
      className: 'hidden md:flex',
      cell: (release) => <span className="truncate text-sm text-muted-foreground">{release.repositoryFullName}</span>,
    },
    {
      id: 'pullRequests',
      header: tr.columns.pullRequests,
      width: 'w-[9rem]',
      className: 'hidden sm:flex',
      cell: (release) => (
        <span className="text-sm tabular-nums">{fill(tr.pullRequestCount, { count: release.pullRequestCount })}</span>
      ),
    },
    {
      id: 'status',
      header: tr.columns.status,
      width: 'w-[7rem]',
      cell: (release) => (
        <SoftBadge tone={release.status === 'shipped' ? 'success' : 'neutral'}>{tr.status[release.status]}</SoftBadge>
      ),
    },
    {
      id: 'updated',
      header: tr.columns.updated,
      width: 'w-[5rem]',
      align: 'right',
      cell: (release) => (
        <span className="text-xs text-muted-foreground">{relativeTime(release.updatedAt, language, tm.justNow)}</span>
      ),
    },
  ];

  const newButton = canManage ? (
    <Button onClick={() => setCreating(true)} disabled={noRepositories || (teams.data ?? []).length === 0}>
      <Plus />
      {tr.newRelease}
    </Button>
  ) : undefined;

  let content: ReactNode;
  if (releases.isLoading) {
    content = <PageLoader fullScreen={false} />;
  } else if (releases.isError) {
    content = <ErrorState message={tr.loadFailed} retryLabel={tm.retry} onRetry={() => void releases.refetch()} />;
  } else if (noRepositories && rows.length === 0) {
    content = (
      <div className="p-6">
        <EmptyState
          icon={Rocket}
          title={tr.empty}
          description={tr.noRepositories}
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
      <ListTable
        columns={columns}
        data={rows}
        rowKey={(release) => release.id}
        rowLabel={(release) => release.name}
        onRowClick={(release) => router.push(`/weldmerge/releases/${release.id}`)}
        emptyState={{
          icon: <Rocket className="size-8 text-muted-foreground/60" />,
          title: view === 'all' ? tr.empty : tr.emptyFiltered,
          description: tr.emptyHint,
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 px-4 pt-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">{tr.title}</h1>
            <p className="text-sm text-muted-foreground">{tr.description}</p>
          </div>
          {newButton}
        </div>
        <PageTabs tabs={tabs} activeTab={view} onTabChange={(id) => setView(id as View)} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>

      <ReleaseFormDialog
        open={creating}
        onOpenChange={setCreating}
        teams={teams.data ?? []}
        repositories={repositories.data ?? []}
        onCreated={(release) => router.push(`/weldmerge/releases/${release.id}`)}
      />
    </div>
  );
}
