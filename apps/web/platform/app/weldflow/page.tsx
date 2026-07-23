
import { useMemo, useState } from 'react';
import { MyTasksClient } from './my-tasks/my-tasks-client';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { useInfiniteMyTasks, type MyTasksFilters } from '@/hooks/queries/use-task-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { PageLoader } from '@/components/page-loader';
import type { ActiveFilter, SortState } from '@/components/entity-list';

/**
 * Translate the EntityList's ActiveFilter[] (field/operator/value tuples)
 * into the shape the api-worker my-tasks endpoint expects. Only `is`
 * operators are honored — `is not` filters are silently dropped for now.
 */
function activeFiltersToServerFilters(filters: ActiveFilter[]): Pick<MyTasksFilters, 'status' | 'priority' | 'projectId' | 'dueDateBucket' | 'labelIds'> {
  const out: Pick<MyTasksFilters, 'status' | 'priority' | 'projectId' | 'dueDateBucket' | 'labelIds'> = {};
  const labels: string[] = [];
  for (const f of filters) {
    if (!f.operator || !f.value || f.operator !== 'is') continue;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const debouncedSearch = useDebounce(searchQuery, 250);

  const filters = useMemo<MyTasksFilters>(() => ({
    search: debouncedSearch || undefined,
    ...activeFiltersToServerFilters(activeFilters),
    ...sortStateToServerSort(sortState),
  }), [debouncedSearch, activeFilters, sortState]);

  const { data: projectsData, isLoading: projectsLoading } = useProjects({ isActive: true });
  const {
    data: tasksData,
    isLoading: tasksLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteMyTasks(filters);

  const isLoading = projectsLoading || tasksLoading;

  const projects = projectsData?.data || [];
  const allTasks = useMemo(
    () => tasksData?.pages.flatMap(page => page.data) || [],
    [tasksData],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="-mx-3 md:-mx-4 -mt-3 md:-mt-4">
      <MyTasksClient
        initialTasks={allTasks}
        projects={projects.map(p => ({ id: p.id, name: p.name }))}
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
