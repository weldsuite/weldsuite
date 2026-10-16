
import { useEffect, useMemo, useState } from 'react';
import { MyTasksClient } from './my-tasks/my-tasks-client';
import { useInfiniteProjects } from '@/hooks/queries/use-projects-queries';
import { useInfiniteMyTasks, type MyTasksFilters } from '@/hooks/queries/use-task-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { ListLoadError } from '@/app/weldflow/components/list-load-error';
import type { ActiveFilter, SortState } from '@/components/entity-list';

type ServerFilterKeys = 'status' | 'excludeStatus' | 'priority' | 'projectId' | 'dueDateBucket' | 'labelIds';

/**
 * Translate the EntityList's ActiveFilter[] (field/operator/value tuples)
 * into the shape the api-worker my-tasks endpoint expects. `is` filters map to
 * query params, and so does "status is not" (`excludeStatus`). The other
 * "is not" filters have no server counterpart: MyTasksClient applies them to the
 * loaded rows itself.
 */
function activeFiltersToServerFilters(filters: ActiveFilter[]): Pick<MyTasksFilters, ServerFilterKeys> {
  const out: Pick<MyTasksFilters, ServerFilterKeys> = {};
  const labels: string[] = [];
  const excludeStatus: string[] = [];
  for (const f of filters) {
    if (!f.operator || !f.value) continue;
    if (f.operator === 'is not') {
      if (f.field === 'status') excludeStatus.push(f.value);
      continue;
    }
    if (f.operator !== 'is') continue;
    switch (f.field) {
      case 'status':
        out.status = f.value;
        break;
      case 'priority':
        out.priority = f.value;
        break;
      case 'project':
        out.projectId = f.value;
        break;
      case 'dueDate':
        out.dueDateBucket = f.value as MyTasksFilters['dueDateBucket'];
        break;
      case 'label':
        labels.push(f.value);
        break;
    }
  }
  if (labels.length > 0) out.labelIds = labels;
  if (excludeStatus.length > 0) out.excludeStatus = excludeStatus;
  return out;
}

function sortStateToServerSort(state: SortState | null): Pick<MyTasksFilters, 'sortField' | 'sortDirection'> {
  if (!state) return {};
  const fieldMap: Record<string, MyTasksFilters['sortField']> = {
    task: 'title',
    title: 'title',
    status: 'status',
    priority: 'priority',
    dueDate: 'dueDate',
    assignee: 'assignee',
  };
  const sortField = fieldMap[state.columnId];
  if (!sortField) return {};
  return { sortField, sortDirection: state.direction };
}

export default function MyTasksPage() {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const debouncedSearch = useDebounce(searchQuery, 250);

  const filters = useMemo<MyTasksFilters>(() => ({
    search: debouncedSearch || undefined,
    includeSubtasks: true,
    ...activeFiltersToServerFilters(activeFilters),
    ...sortStateToServerSort(sortState),
  }), [debouncedSearch, activeFilters, sortState]);

  // Every active project, not just the first page: the project picker and filter
  // would otherwise stop at the server's default page of 25.
  const {
    data: projectsData,
    isLoading: projectsLoading,
    hasNextPage: hasMoreProjects,
    isFetchingNextPage: isFetchingMoreProjects,
    fetchNextPage: fetchMoreProjects,
  } = useInfiniteProjects({ isActive: true }, 100);
  useEffect(() => {
    if (hasMoreProjects && !isFetchingMoreProjects) void fetchMoreProjects();
  }, [hasMoreProjects, isFetchingMoreProjects, fetchMoreProjects]);

  const {
    data: tasksData,
    isLoading: tasksLoading,
    isError: tasksFailed,
    refetch: refetchTasks,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteMyTasks(filters);

  const isLoading = projectsLoading || tasksLoading;

  const projects = useMemo(
    () => projectsData?.pages.flatMap(page => page.data) ?? [],
    [projectsData],
  );
  const allTasks = useMemo(
    () => tasksData?.pages.flatMap(page => page.data) || [],
    [tasksData],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (tasksFailed && !tasksData) {
    return (
      <ListLoadError
        message={t.projects.myTasks.failedToLoad}
        retryLabel={t.projects.myTasks.retry}
        onRetry={() => { void refetchTasks(); }}
      />
    );
  }

  return (
    <div className="-mx-3 md:-mx-4 -mt-3 md:-mt-4">
      <MyTasksClient
        initialTasks={allTasks}
        projects={projects.map(p => ({ id: p.id, name: p.name, color: p.color, icon: p.icon }))}
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
    </div>
  );
}
