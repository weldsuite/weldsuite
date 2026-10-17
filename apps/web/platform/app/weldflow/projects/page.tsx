
import { useMemo, useState } from 'react';
import { useInfiniteProjects, type ProjectListFilters } from '@/hooks/queries/use-projects-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { AllProjectsClient } from './all-projects-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { ListLoadError } from '@/app/weldflow/components/list-load-error';
import type { ActiveFilter, SortState } from '@/components/entity-list';

function activeFiltersToServer(filters: ActiveFilter[]): Pick<ProjectListFilters, 'status' | 'priority' | 'ownerId'> {
  const out: Pick<ProjectListFilters, 'status' | 'priority' | 'ownerId'> = {};
  for (const f of filters) {
    if (!f.operator || !f.value || f.operator !== 'is') continue;
    if (f.field === 'status') out.status = f.value;
    else if (f.field === 'priority') out.priority = f.value;
    else if (f.field === 'owner') out.ownerId = f.value;
  }
  return out;
}

function sortStateToServer(state: SortState | null): Pick<ProjectListFilters, 'sortField' | 'sortDirection'> {
  if (!state) return {};
  const fieldMap: Record<string, ProjectListFilters['sortField']> = {
    name: 'name',
    project: 'name',
    status: 'status',
    priority: 'priority',
    dueDate: 'dueDate',
    owner: 'owner',
  };
  const sortField = fieldMap[state.columnId];
  if (!sortField) return {};
  return { sortField, sortDirection: state.direction };
}

export default function AllProjectsPage() {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const debouncedSearch = useDebounce(searchQuery, 250);

  const filters = useMemo<ProjectListFilters>(() => ({
    search: debouncedSearch || undefined,
    ...activeFiltersToServer(activeFilters),
    ...sortStateToServer(sortState),
  }), [debouncedSearch, activeFilters, sortState]);

  const {
    data: projectsData,
    error: projectsError,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteProjects(filters);

  const allProjects = useMemo(
    () => projectsData?.pages.flatMap(p => p.data) ?? [],
    [projectsData],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;
  // A failed first load must not fall through to the "no projects" empty state.
  if (isError && !projectsData) {
    return (
      <ListLoadError
        message={t.projects.allProjects.failedToLoad}
        retryLabel={t.projects.allProjects.retry}
        onRetry={() => { void refetch(); }}
      />
    );
  }

  return (
    <AllProjectsClient
      initialProjects={allProjects}
      error={projectsError ? String(projectsError) : null}
      hasNextPage={!!hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadMore={() => fetchNextPage()}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      activeFilters={activeFilters}
      onFiltersChange={setActiveFilters}
      sortState={sortState}
      onSortChange={setSortState}
    />
  );
}
