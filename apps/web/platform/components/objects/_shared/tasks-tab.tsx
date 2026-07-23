/**
 * `TasksTab` — Tasks tab for CRM object panels (company / person).
 *
 * Renders the FULL WeldFlow task board (TasksClient) scoped to the given entity.
 * Tasks are fetched via `useTasks` with `customerId` or `personId` and span
 * multiple projects. The board component handles all inline edits, filtering,
 * sorting, group-by, subtask expansion, and the task detail panel — exactly as
 * on the /weldflow/project/:projectId/tasks page — without forking the UI.
 *
 * Entity-mode differences (enforced inside TasksClient via `entityScope`):
 *   - DnD reorder is disabled (no single project position sequence).
 *   - Project stages are not fetched (group-by defaults to status labels).
 *   - Project members are derived from task assignees rather than a per-project query.
 *   - "Add task" navigates to /weldflow/my-tasks?customerId=… instead of opening
 *     the create dialog (no single project to create into).
 *   - Breadcrumbs are suppressed (panel is not a page).
 *   - `useProjectPermissions` falls back to a permissive default.
 */

import { useState, useMemo } from 'react';
import { TasksClient } from '@/app/weldflow/project/[projectId]/tasks/tasks-client';
import { useTasks } from '@/hooks/queries/use-task-queries';
import { useDebounce } from '@/hooks/use-debounce';
import type { ActiveFilter, SortState } from '@/components/entity-list';
import type { Projects } from '@/lib/api/types/apps/projects.types';
import { PageLoader } from '@/components/page-loader';

export interface TasksTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function TasksTab({ entityId, entityKind }: TasksTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const debouncedSearch = useDebounce(searchQuery, 250);

  const { data, isLoading } = useTasks(
    entityKind === 'company'
      ? { customerId: entityId, pageSize: 100, search: debouncedSearch || undefined }
      : { personId: entityId, pageSize: 100, search: debouncedSearch || undefined },
  );

  // useTasks returns `data.data` as any[]. The shape is the same as what the
  // /tasks endpoint returns when queried by projectId — same enrichment (assignees,
  // scheduledStart/End, etc.) — so it satisfies Projects.ProjectTask.
  const allTasks = useMemo<Projects.ProjectTask[]>(
    () => (data?.data ?? []) as Projects.ProjectTask[],
    [data],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <TasksClient
      // A synthetic projectId is required by the prop type but is never used for
      // project-scoped API calls in entity mode — entityScope guards all such paths.
      projectId=""
      initialTasks={allTasks}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadMore={() => {}}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      activeFilters={activeFilters}
      onFiltersChange={setActiveFilters}
      sortState={sortState}
      onSortChange={setSortState}
      entityScope={{ kind: entityKind, id: entityId }}
    />
  );
}
