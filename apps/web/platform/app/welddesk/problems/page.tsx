/**
 * WeldDesk → Problems: the causes behind recurring tickets (TASK-1231), with
 * the known-error database one tab away. Tabs filter by where a problem
 * stands; the search matches title, text, workaround and `#number`.
 */

import { useDeferredValue, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useDeskAttributeOptions } from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { useDeskProblems, type DeskProblem, type DeskProblemView } from '@/hooks/queries/use-desk-problem-queries';
import { PRIORITY_DOT } from '../inbox/ticket-fields';
import { CreateProblemDialog } from './create-problem-dialog';
import { ProblemStatusBadge } from './problem-status-badge';

const VIEWS: DeskProblemView[] = ['open', 'known_errors', 'done', 'all'];

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export default function DeskProblemsPage() {
  const t = getTranslations('deskProblems');
  const router = useRouter();
  const canCreate = useCan('problems:create');
  const [view, setView] = useState<DeskProblemView>('open');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());
  const { data, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useDeskProblems({ view, q });
  const { data: members = [] } = useDeskWorkspaceMembers();
  const { data: options } = useDeskAttributeOptions();

  useBreadcrumbs([{ label: getTranslations('helpdesk').title, href: '/welddesk' }, { label: t.list.title }]);

  const problems = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);
  const ownerOf = (id: string | null) => (id ? members.find((member) => member.userId === id)?.name ?? id : null);
  const teamOf = (id: string | null) => (id ? options?.teams.find((team) => team.id === id)?.name ?? null : null);

  const columns: ListTableColumn<DeskProblem>[] = [
    { id: 'number', header: t.list.columns.number, width: 'w-[64px]', cell: (row) => <span className="text-muted-foreground">#{row.problemNumber}</span> },
    { id: 'title', header: t.list.columns.title, cell: (row) => <span className="font-medium">{row.title}</span> },
    { id: 'status', header: t.list.columns.status, width: 'w-[130px]', cell: (row) => <ProblemStatusBadge status={row.status} /> },
    {
      id: 'priority',
      header: t.list.columns.priority,
      width: 'w-[100px]',
      cell: (row) =>
        row.priority ? (
          <span className="inline-flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[row.priority]}`} />
            {t.priority[row.priority]}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'owner',
      header: t.list.columns.owner,
      width: 'w-[150px]',
      cell: (row) => ownerOf(row.assigneeId) ?? <span className="text-muted-foreground">{t.list.unowned}</span>,
    },
    {
      id: 'team',
      header: t.list.columns.team,
      width: 'w-[130px]',
      cell: (row) => teamOf(row.departmentId) ?? <span className="text-muted-foreground">{t.list.noTeam}</span>,
    },
    {
      id: 'incidents',
      header: t.list.columns.incidents,
      width: 'w-[130px]',
      align: 'right',
      cell: (row) => (
        <span data-testid="desk-problem-incidents">
          {t.list.countOf.replace('{open}', String(row.openIncidentCount)).replace('{total}', String(row.incidentCount))}
        </span>
      ),
    },
    { id: 'updated', header: t.list.columns.updated, width: 'w-[120px]', cell: (row) => <span className="text-muted-foreground">{formatDate(row.updatedAt)}</span> },
  ];

  const tabs = VIEWS.map((id) => ({
    id,
    label: id === 'known_errors' ? t.list.tabs.knownErrors : t.list.tabs[id],
  }));

  const searching = q !== '';
  const emptyTitle = view === 'known_errors' ? t.list.emptyKnownErrors : t.list.empty;

  return (
    <DashboardPage
      title={t.list.title}
      description={t.list.description}
      actions={
        canCreate && (
          <Button onClick={() => setCreating(true)} data-testid="desk-problem-new">
            <Plus className="mr-1.5 h-4 w-4" />
            {t.list.newProblem}
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTabs tabs={tabs} activeTab={view} onTabChange={(id) => setView(id as DeskProblemView)} className="min-w-0 flex-1" />
        <SearchInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t.list.searchPlaceholder}
          aria-label={t.list.searchPlaceholder}
          maxLength={200}
          className="w-64"
        />
      </div>

      {isLoading && <PageLoader />}
      {isError && <ErrorState message={t.list.loadError} onRetry={() => void refetch()} retryLabel={t.list.retry} />}
      {!isLoading && !isError && (
        <>
          <ListTable
            columns={columns}
            data={problems}
            rowKey={(row) => row.id}
            rowLabel={(row) => t.list.openProblem.replace('{number}', String(row.problemNumber))}
            onRowClick={(row) => router.push(`/welddesk/problems/${row.id}`)}
            emptyState={
              searching
                ? { title: t.list.emptySearch }
                : { title: emptyTitle, description: view === 'known_errors' ? undefined : t.list.emptyHint }
            }
          />
          {hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {t.list.loadMore}
              </Button>
            </div>
          )}
        </>
      )}

      <CreateProblemDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(problem) => router.push(`/welddesk/problems/${problem.id}`)}
      />
    </DashboardPage>
  );
}
