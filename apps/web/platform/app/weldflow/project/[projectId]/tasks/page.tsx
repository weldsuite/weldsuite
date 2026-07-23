
import { useMemo, useState } from 'react';
import { useParams } from '@/lib/router';
import { TasksClient } from './tasks-client';
import { useInfiniteProjectTasks, type ProjectTaskFilters } from '@/hooks/queries/use-projects-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { PageLoader } from '@/components/page-loader';
import type { ActiveFilter, SortState } from '@/components/entity-list';

function activeFiltersToServer(filters: ActiveFilter[]): Pick<ProjectTaskFilters, 'status' | 'priority' | 'dueDateBucket' | 'labelIds' | 'assigneeId'> {
  const out: Pick<ProjectTaskFilters, 'status' | 'priority' | 'dueDateBucket' | 'labelIds' | 'assigneeId'> = {};
  const labels: string[] = [];
  for (const f of filters) {
    if (!f.operator || !f.value || f.operator !== 'is') continue;
    switch (f.field) {
      case 'status': out.status = f.value; break;
      case 'priority': out.priority = f.value; break;
      case 'assignee': out.assigneeId = f.value; break;
      case 'dueDate': out.dueDateBucket = f.value as ProjectTaskFilters['dueDateBucket']; break;
      case 'label': labels.push(f.value); break;
    }
  }
  if (labels.length > 0) out.labelIds = labels;
  return out;
}

function sortStateToServer(state: SortState | null): Pick<ProjectTaskFilters, 'sortField' | 'sortDirection'> {
  if (!state) return {};
  const fieldMap: Record<string, ProjectTaskFilters['sortField']> = {
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

export default function TasksPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const debouncedSearch = useDebounce(searchQuery, 250);

  const filters = useMemo<ProjectTaskFilters>(() => ({
    search: debouncedSearch || undefined,
    includeSubtasks: true,
    ...activeFiltersToServer(activeFilters),
    ...sortStateToServer(sortState),
  }), [debouncedSearch, activeFilters, sortState]);

  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteProjectTasks(projectId, filters, 50);

  const allTasks = useMemo(
    () => data?.pages.flatMap(p => p.data) ?? [],
    [data],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <TasksClient
      projectId={projectId}
      initialTasks={allTasks}
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
