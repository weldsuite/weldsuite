
import React, { useState, useMemo, useTransition, useCallback, useEffect, useRef } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { useObjectPanel } from '@/components/object-panel';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
import { TaskNumberBadge } from '@/components/weldflow/task-number-badge';
import { useAuth } from '@clerk/clerk-react';
import { useQueryClient } from '@tanstack/react-query';
import { taskKeys } from '@/hooks/queries/use-task-queries';
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  EllipsisVertical,
  CheckCircle2,
  Circle,
  Clock,
  Check,
  Pencil,
  Trash2,
  Copy,
  List,
  Columns3,
  Repeat,
  FolderKanban,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { coloredSquareColors, findColoredSquareIconByLabel } from '@/components/app-sidebar-layout';
import { toast } from 'sonner';
import { tasksApi, labelsApi } from '../lib/api-client';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import { buildEntityAssigneeDirectory } from '../project/[projectId]/tasks/entity-assignees';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import { normalizeTaskStatus } from '@weldsuite/app-api-client/schemas/tasks';
import { LabelOverflowList } from '../lib/label-overflow-list';
import { withOtherGroup } from '../lib/with-other-group';
import type { Projects } from '@/lib/api/types/apps/projects.types';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type SortState } from '@/components/entity-list';
import { MyTasksPipeline } from './my-tasks-pipeline';

/** The priorities a task row can hold. */
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

interface Task {
  id: string;
  /** Workspace-wide sequential number, rendered as the bare number. */
  number?: number | null;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'testing' | 'done' | 'cancelled';
  priority: TaskPriority;
  assignee?: string;
  assigneeId?: string;
  assigneeIds?: string[];
  assignees?: { id: string; name: string; avatar?: string }[];
  dueDate?: Date;
  startDate?: Date;
  duration?: number;
  estimatedHours?: number;
  createdAt: Date;
  project?: string;
  projectId?: string;
  tags?: string[];
  labels?: string[];
  parentTaskId?: string | null;
  /** Reached only through a parent's subtask tree (not assigned to me): shown nested, never as a row of its own. */
  nestedOnly?: boolean;
  repeat?: { frequency: string; interval?: number; unit?: string } | null;
  scheduledStart?: string | Date | null;
  scheduledEnd?: string | Date | null;
  autoScheduled?: boolean | null;
}

export interface ProjectLabel {
  id: string;
  name: string;
  color: string;
  projectId?: string | null;
}

interface ProjectInfo {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
}

interface MyTasksClientProps {
  initialTasks: Projects.ProjectTask[];
  projects: ProjectInfo[];
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  // Controlled-mode (server-side filtering / search / sort). When supplied,
  // the page owns these and drives the api-worker query.
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  activeFilters?: ActiveFilter[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;
  sortState?: SortState | null;
  onSortChange?: (state: SortState | null) => void;
}

const priorityConfigBase = {
  low: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  medium: { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  high: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  urgent: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  critical: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
};

const statusConfigBase = {
  backlog: { icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  todo: { icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  in_progress: { icon: Clock, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  review: { icon: Clock, color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950' },
  testing: { icon: Clock, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
  done: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  cancelled: { icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

// `/tasks` responses also carry `duration`/`repeat`, which aren't modeled on
// the shared `Projects.ProjectTask` type — extend it locally for this transform.
type ApiTaskWithSchedule = Projects.ProjectTask & {
  duration?: number;
  repeat?: { frequency: string; interval?: number; unit?: string } | null;
  /** Subtask tree, present when the list is fetched with includeSubtasks=true. */
  children?: ApiTaskWithSchedule[];
};

// Prefer the multi-assignee array, fall back to the singular assignee id.
function resolveApiAssigneeIds(apiTask: ApiTaskWithSchedule): string[] | undefined {
  if (apiTask.assigneeIds && apiTask.assigneeIds.length > 0) return apiTask.assigneeIds;
  if (apiTask.assigneeId) return [apiTask.assigneeId];
  return undefined;
}

// Transform API task to local Task format
function transformApiTask(apiTask: ApiTaskWithSchedule): Task {
  return {
    id: apiTask.id,
    number: apiTask.number ?? null,
    title: apiTask.title,
    description: apiTask.description || undefined,
    status: (normalizeTaskStatus(apiTask.status) as Task['status']) || 'todo',
    priority: (apiTask.priority as Task['priority']) || 'medium',
    assignee: apiTask.assignee?.name || undefined,
    assigneeId: apiTask.assigneeId || undefined,
    assigneeIds: resolveApiAssigneeIds(apiTask),
    assignees: apiTask.assignees
      ? apiTask.assignees.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar }))
      : undefined,
    dueDate: apiTask.dueDate ? new Date(apiTask.dueDate) : undefined,
    startDate: apiTask.startDate ? new Date(apiTask.startDate) : undefined,
    duration: apiTask.duration ?? undefined,
    estimatedHours: apiTask.estimatedHours ?? undefined,
    createdAt: new Date(apiTask.createdAt),
    project: apiTask.project?.name || undefined,
    projectId: apiTask.projectId || undefined,
    labels: apiTask.labels || undefined,
    parentTaskId: apiTask.parentTaskId || null,
    repeat: apiTask.repeat || null,
  };
}

// Flatten the server rows plus their subtask trees into one list, so every
// row-level action (status, inline edit, delete) finds subtasks by id. The
// render step regroups them under their parent via `parentTaskId`.
function flattenApiTasks(apiTasks: ApiTaskWithSchedule[]): Task[] {
  const ownIds = new Set(apiTasks.map((task) => task.id));
  const seen = new Set<string>();
  const out: Task[] = [];
  const add = (apiTask: ApiTaskWithSchedule, parent: Task | undefined): Task => {
    const task: Task = { ...transformApiTask(apiTask), nestedOnly: !ownIds.has(apiTask.id) };
    // Tree rows don't carry the project summary; a subtask shares its parent's project.
    if (!task.project && parent?.project && (!task.projectId || task.projectId === parent.projectId)) {
      task.project = parent.project;
      task.projectId = parent.projectId;
    }
    if (!seen.has(apiTask.id)) {
      seen.add(apiTask.id);
      out.push(task);
    }
    return task;
  };
  const walk = (apiTask: ApiTaskWithSchedule, parent?: Task) => {
    const task = add(apiTask, parent);
    for (const child of apiTask.children ?? []) walk(child, task);
  };
  for (const apiTask of apiTasks) walk(apiTask);
  return out;
}

// Map project status to CRM status format (now 1:1 since CRM uses same statuses)
const statusToCrm: Record<string, CrmTask['status']> = {
  'backlog': 'backlog',
  'todo': 'todo',
  'in_progress': 'in_progress',
  'review': 'review',
  'testing': 'testing',
  'done': 'done',
  'cancelled': 'cancelled',
};

const statusFromCrm: Record<string, Task['status']> = {
  'backlog': 'backlog',
  'todo': 'todo',
  'in_progress': 'in_progress',
  'review': 'review',
  'testing': 'testing',
  'done': 'done',
  'cancelled': 'cancelled',
};

function resolveCrmAssignees(task: Task): { id: string; name: string; avatar?: string }[] {
  if (task.assignees && task.assignees.length > 0) {
    return task.assignees.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar }));
  }
  if (task.assigneeId && task.assignee) return [{ id: task.assigneeId, name: task.assignee }];
  return [];
}

function toCrmTask(task: Task): CrmTask {
  // Build the multi-assignee array the panel actually renders. Without this,
  // the panel only ever sees the singular `assignee` and the picker can't
  // mark additional users as selected even though they're stored on the task.
  const assigneesList = resolveCrmAssignees(task);
  const primary = assigneesList[0];
  return {
    id: task.id,
    number: task.number,
    title: task.title,
    description: task.description,
    // Unknown (custom stage) statuses pass through instead of collapsing to
    // 'todo', which a save would then write back.
    status: statusToCrm[task.status] ?? (task.status as CrmTask['status']),
    priority: task.priority as CrmTask['priority'],
    assignee: primary,
    assignees: assigneesList,
    dueDate: task.dueDate,
    duration: task.duration,
    createdAt: task.createdAt,
    labels: task.labels,
    repeat: (task.repeat || undefined) as CrmTask['repeat'],
    scheduledStart: task.scheduledStart ? new Date(task.scheduledStart) : null,
    scheduledEnd: task.scheduledEnd ? new Date(task.scheduledEnd) : null,
    autoScheduled: task.autoScheduled ?? null,
    linkedCompany: task.projectId ? { id: task.projectId, name: task.project ?? '' } : undefined,
  };
}

// Merge optimistic-only fields from the previous copy of a task (`p`) into the
// fresh server copy (`f`) when the server response is missing them.
function mergeOptimisticTaskFields(f: Task, p: Task): Task {
  const out: Task = { ...f };
  if ((f.assigneeIds?.length ?? 0) < (p.assigneeIds?.length ?? 0)) {
    out.assigneeIds = p.assigneeIds;
  }
  if ((f.assignees?.length ?? 0) < (p.assignees?.length ?? 0)) {
    out.assignees = p.assignees;
  }
  fillMissingScalarFields(out, p);
  if ((!out.labels || out.labels.length === 0) && p.labels?.length) out.labels = p.labels;
  if (!out.description && p.description) out.description = p.description;
  return out;
}

function fillMissingScalarFields(out: Task, p: Task): void {
  if (out.duration == null && p.duration != null) out.duration = p.duration;
  if (out.estimatedHours == null && p.estimatedHours != null) out.estimatedHours = p.estimatedHours;
  if (out.startDate == null && p.startDate != null) out.startDate = p.startDate;
  if (out.dueDate == null && p.dueDate != null) out.dueDate = p.dueDate;
  if (out.priority == null && p.priority != null) out.priority = p.priority;
}

interface SaveTaskFormData {
  title: string;
  description?: string;
  status: Task['status'];
  priority?: TaskPriority;
  assigneeId?: string;
  assigneeIds?: string[];
  dueDate?: Date;
  duration?: number;
  linkedCompanyId?: string;
  labels?: string[];
  repeat?: { frequency: string; interval?: number; unit?: string };
}

// The API response may not include all fields, so fill the gaps from the form
// data the user just entered.
function fillNewTaskFromForm(
  newTask: Task,
  data: SaveTaskFormData,
  selectedProject: ProjectInfo | undefined,
  availableAssignees: { id: string; name: string; avatar?: string }[],
): void {
  if (!newTask.assignee && data.assigneeId) {
    const member = availableAssignees.find(a => a.id === data.assigneeId);
    if (member) {
      newTask.assignee = member.name;
      newTask.assigneeId = data.assigneeId;
    }
  }
  if (!newTask.project && selectedProject) {
    newTask.project = selectedProject.name;
    newTask.projectId = selectedProject.id;
  }
  fillNewTaskScalarsFromForm(newTask, data);
}

function fillNewTaskScalarsFromForm(newTask: Task, data: SaveTaskFormData): void {
  if (!newTask.dueDate && data.dueDate) newTask.dueDate = data.dueDate;
  if (!newTask.priority && data.priority) newTask.priority = data.priority;
  if ((!newTask.labels || newTask.labels.length === 0) && data.labels?.length) {
    newTask.labels = data.labels;
  }
  if (!newTask.description && data.description) newTask.description = data.description;
  if (newTask.duration == null && data.duration != null) newTask.duration = data.duration;
}

type TaskUpdatePayload = Parameters<typeof tasksApi.update>[2];

// Applies the multi-assignee `assigneeIds` normalisation to an inline-edit
// payload (multi-assignee fields win over the singular ones). An empty list
// goes out as `[]`, which unassigns everyone.
function applyAssigneePayload(payload: TaskUpdatePayload, data: Partial<Task>): void {
  if (data.assigneeIds !== undefined || data.assignees !== undefined) {
    payload.assigneeIds = data.assigneeIds === undefined
      ? data.assignees?.map((a) => a.id) ?? []
      : data.assigneeIds;
  } else if (data.assigneeId !== undefined) {
    payload.assigneeIds = data.assigneeId ? [data.assigneeId] : [];
  }
}

// Build the API payload for an inline task edit. Cleared fields go out as an
// explicit `null`: `undefined` is dropped by JSON.stringify, so the server never
// heard that a date had been cleared (the UI only looked cleared until a reload).
function buildTaskUpdatePayload(data: Partial<Task>): TaskUpdatePayload {
  const payload: TaskUpdatePayload = {};
  if (data.title !== undefined) payload.title = data.title;
  if (data.priority !== undefined) payload.priority = data.priority;
  if ('dueDate' in data) payload.dueDate = data.dueDate ? data.dueDate.toISOString() : null;
  if ('startDate' in data) payload.startDate = data.startDate ? data.startDate.toISOString() : null;
  applyAssigneePayload(payload, data);
  return payload;
}

// Build the inline-update payload for toggling `memberId` in a task's assignee list.
function buildAssigneeToggleUpdate(
  resolvedIds: string[],
  memberId: string,
  isSelected: boolean,
  availableAssignees: { id: string; name: string; avatar?: string }[],
): Partial<Task> {
  const nextIds = isSelected
    ? resolvedIds.filter((id) => id !== memberId)
    : [...resolvedIds, memberId];
  const nextAssignees = nextIds.map((id) => {
    const m = availableAssignees.find((x) => x.id === id);
    return { id, name: m?.name || '', avatar: m?.avatar };
  });
  const primary = nextAssignees[0];
  return {
    assigneeId: primary?.id ?? null,
    assignee: primary?.name,
    assigneeIds: nextIds,
    assignees: nextAssignees,
  };
}

function formatRepeatBadge(repeat: { frequency: string; interval?: number; unit?: string }): string {
  if (repeat.frequency === 'custom' && repeat.interval && repeat.unit) {
    return `${repeat.interval}${repeat.unit.charAt(0)}`;
  }
  if (repeat.frequency === 'biweekly') return '2w';
  return repeat.frequency.charAt(0).toUpperCase();
}

const restrictToVerticalAxis = ({ transform }: { transform: { x: number; y: number; scaleX: number; scaleY: number } }) => ({
  ...transform,
  x: 0,
});

// Dragged row snaps to the target slot. Non-dragged rows use dnd-kit's own shift
// transform so they fill the gap the dragged row leaves behind. We override transition
// for both so they share the exact same timing and never cross paths mid-animation.
function computeDragSnapY(
  isDragging: boolean,
  rectHeight: number | undefined,
  activeIndex: number,
  overIndex: number,
): number {
  if (!isDragging || rectHeight === undefined || activeIndex === -1) return 0;
  const targetIndex = overIndex === -1 ? activeIndex : overIndex;
  return (targetIndex - activeIndex) * rectHeight;
}

// Only apply drag-related layout styles while a sort is in progress. When idle, leave
// the row completely alone so there are no stray stacking contexts or transitions that
// could flicker during normal hover.
function buildSortableRowStyle({
  isSorting,
  isDragging,
  isDragEnabled,
  snapY,
  transform,
}: {
  isSorting: boolean;
  isDragging: boolean;
  isDragEnabled: boolean;
  snapY: number;
  transform: Parameters<typeof CSS.Transform.toString>[0];
}): React.CSSProperties {
  if (!isSorting) {
    return { cursor: isDragEnabled ? 'grab' : undefined };
  }
  return {
    transform: isDragging
      ? `translate3d(0, ${snapY}px, 0)`
      : CSS.Transform.toString(transform),
    transition: 'transform 150ms cubic-bezier(0.2, 0, 0, 1)',
    position: 'relative',
    zIndex: isDragging ? 50 : undefined,
    backgroundColor: isDragging ? 'var(--background)' : undefined,
    cursor: isDragEnabled ? 'grabbing' : undefined,
  };
}

function SortableTaskRow({ id, isDragEnabled, children }: Readonly<{ id: string; isDragEnabled: boolean; children: React.ReactNode }>) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
    isSorting,
    activeIndex,
    overIndex,
    rect,
  } = useSortable({
    id,
    disabled: !isDragEnabled,
    animateLayoutChanges: () => false,
  });

  const snapY = computeDragSnapY(isDragging, rect.current?.height, activeIndex, overIndex);
  const style = buildSortableRowStyle({ isSorting, isDragging, isDragEnabled, snapY, transform });

  return (
    <div ref={setNodeRef} style={style} {...(isDragEnabled ? { ...attributes, ...listeners } : {})}>
      {children}
    </div>
  );
}

export function MyTasksClient({
  initialTasks,
  projects,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  searchQuery: searchQueryProp,
  onSearchChange,
  activeFilters: activeFiltersProp,
  onFiltersChange,
  sortState: sortStateProp,
  onSortChange,
}: Readonly<MyTasksClientProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const { formatShort } = useDateLocale();
  // Task a row's "Delete" menu item asked to delete, until the user confirms.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  useBreadcrumbs([
    { label: t.projects.title, href: '/weldflow' },
    { label: t.projects.myTasks.title },
  ]);

  const priorityConfig = useMemo(() => ({
    low: { label: t.projects.myTasks.priorityLabels.low, ...priorityConfigBase.low },
    medium: { label: t.projects.myTasks.priorityLabels.medium, ...priorityConfigBase.medium },
    high: { label: t.projects.myTasks.priorityLabels.high, ...priorityConfigBase.high },
    urgent: { label: t.projects.myTasks.priorityLabels.urgent, ...priorityConfigBase.urgent },
    critical: { label: t.projects.myTasks.priorityLabels.critical, ...priorityConfigBase.critical },
  }), [t]);

  const statusConfig = useMemo(() => ({
    backlog: { label: t.projects.myTasks.statusLabels.backlog, ...statusConfigBase.backlog },
    todo: { label: t.projects.myTasks.statusLabels.todo, ...statusConfigBase.todo },
    in_progress: { label: t.projects.myTasks.statusLabels.inProgress, ...statusConfigBase.in_progress },
    review: { label: t.projects.myTasks.statusLabels.inReview, ...statusConfigBase.review },
    testing: { label: t.projects.myTasks.statusLabels.testing, ...statusConfigBase.testing },
    done: { label: t.projects.myTasks.statusLabels.done, ...statusConfigBase.done },
    cancelled: { label: t.projects.myTasks.statusLabels.cancelled, ...statusConfigBase.cancelled },
  }), [t]);

  const [tasks, setTasks] = useState<Task[]>(() => flattenApiTasks(initialTasks));
  // Rows this page added itself (created, duplicated, next recurrence) that the
  // server list may not echo yet. Only these survive a refetch: the list stays
  // mounted across a new search / filter, so keeping every unechoed row would
  // leave rows that no longer match the filter on screen.
  const optimisticIdsRef = useRef(new Set<string>());
  const addOptimisticTask = useCallback((task: Task, position: 'start' | 'end' = 'start') => {
    optimisticIdsRef.current.add(task.id);
    setTasks((prev) => (position === 'start' ? [task, ...prev] : [...prev, task]));
  }, []);
  const prevInitialTasksRef = useRef(initialTasks);
  useEffect(() => {
    if (prevInitialTasksRef.current !== initialTasks) {
      prevInitialTasksRef.current = initialTasks;
      setTasks((prev) => {
        const fresh = flattenApiTasks(initialTasks);
        const freshById = new Map(fresh.map((f) => [f.id, f]));
        const prevById = new Map(prev.map((p) => [p.id, p]));

        // Walk fresh in server order so the displayed order always matches the
        // server's deterministic ORDER BY. For each fresh row, merge in any
        // optimistic-only fields from the prev copy. Then append the rows this
        // page just added that the server hasn't echoed yet (replica lag) so
        // they don't blink out.
        const merged: Task[] = fresh.map((f) => {
          const p = prevById.get(f.id);
          return p ? mergeOptimisticTaskFields(f, p) : f;
        });

        for (const id of optimisticIdsRef.current) {
          if (freshById.has(id)) optimisticIdsRef.current.delete(id);
        }
        const optimisticOnly = prev.filter((p) => optimisticIdsRef.current.has(p.id));
        return [...merged, ...optimisticOnly];
      });
    }
  }, [initialTasks]);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  // Status preset for the create dialog (the board column it was opened from).
  const [dialogDefaultStatus, setDialogDefaultStatus] = useState<Task['status'] | undefined>(undefined);
  const [showSubtaskDialog, setShowSubtaskDialog] = useState(false);
  // When the page provides controlled sort/filter/search props we defer to it
  // so the api-worker query is keyed off those values. Otherwise fall back to
  // local state for back-compat with any other consumer.
  const isSortControlled = onSortChange !== undefined;
  const [internalSortState, setInternalSortState] = useState<SortState | null>(null);
  const sortState = isSortControlled ? (sortStateProp ?? null) : internalSortState;
  const setSortState = useCallback((next: SortState | null | ((prev: SortState | null) => SortState | null)) => {
    if (isSortControlled) {
      const resolved = typeof next === 'function' ? (next as (prev: SortState | null) => SortState | null)(sortState) : next;
      onSortChange!(resolved);
    } else {
      setInternalSortState(next);
    }
  }, [isSortControlled, sortState, onSortChange]);
  const [editingCrmTask, setEditingCrmTask] = useState<CrmTask | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // The task detail panel is now rendered globally via the object-panel host.
  // `selectedTask` is still kept as the page's "active row" pointer (some
  // table interactions reference it), but opening/closing the drawer is done
  // by pushing the task onto the object-panel stack via `useObjectPanel`.
  const { open: openTaskPanel } = useObjectPanel();
  // Opening is driven by the click itself, not by a change of `selectedTask`:
  // after the panel is closed `selectedTask` still points at the same row, so
  // clicking it again changed nothing and the panel could not be reopened (and
  // an optimistic edit of that row would have popped the closed panel back up).
  const openTask = useCallback((task: Task) => {
    setSelectedTask(task);
    openTaskPanel({ type: 'task', id: task.id });
  }, [openTaskPanel]);

  const [isPending, startTransition] = useTransition();
  const [availableLabels, setAvailableLabels] = useState<ProjectLabel[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'pipeline'>('list');
  const [groupBy, setGroupBy] = useState<'status' | 'priority' | 'dueDate' | 'project' | 'none'>('status');

  // Drag-and-drop state for table view
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );
  const isDragEnabled = !sortState;
  const { userId } = useAuth();
  const queryClient = useQueryClient();

  // Infinite scroll sentinel
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasNextPage || !onLoadMore) return;
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          onLoadMore();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  const handleSaveSubtask = useCallback((data: {
    title: string;
    description?: string;
    status: Task['status'];
    priority?: TaskPriority;
    assigneeId?: string;
    dueDate?: Date;
    labels?: string[];
  }) => {
    if (!selectedTask?.projectId) return;
    startTransition(async () => {
      const result = await tasksApi.create(selectedTask.projectId!, {
        title: data.title,
        description: data.description,
        status: data.status || 'todo',
        priority: data.priority,
        assigneeId: data.assigneeId,
        dueDate: data.dueDate?.toISOString(),
        labels: data.labels,
        parentTaskId: selectedTask.id,
      });
      if (result.success && result.data) {
        setShowSubtaskDialog(false);
        toast.success(t.projects.myTasks.subtaskCreated);
        void queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
      } else {
        toast.error(t.projects.myTasks.subtaskCreateFailed);
      }
    });
  }, [selectedTask, startTransition, queryClient, t.projects.myTasks.subtaskCreated, t.projects.myTasks.subtaskCreateFailed]);

  // Fetch workspace labels
  useEffect(() => {
    async function loadLabels() {
      const result = await labelsApi.list();
      if (result.success && result.data) {
        setAvailableLabels(result.data);
      }
    }
    void loadLabels();
  }, []);

  const handleCreateLabel = useCallback(async (data: { name: string; color: string }): Promise<ProjectLabel | null> => {
    const result = await labelsApi.create(data);
    if (result.success && result.data) {
      const newLabel: ProjectLabel = { id: result.data.id, name: data.name, color: data.color };
      setAvailableLabels(prev => [newLabel, ...prev]);
      return newLabel;
    }
    toast.error(t.projects.myTasks.failedToCreateLabel);
    return null;
  }, [t.projects.myTasks.failedToCreateLabel]);

  // Assignee dropdown: the workspace member directory (one batched request
  // instead of one members call per project), plus anyone already on a loaded
  // task who has since left the workspace, so their name still renders.
  const { data: workspaceMembersData } = useWorkspaceMemberDirectory();
  const availableAssignees = useMemo(
    () =>
      buildEntityAssigneeDirectory(workspaceMembersData?.data ?? [], tasks).map((m) => ({
        id: m.userId,
        name: m.user.name,
        avatar: m.user.avatar,
      })),
    [workspaceMembersData, tasks],
  );

  // Live task sync: useRealtimeSync(platformSyncMap) invalidates ['task'] /
  // ['projects'] — no parallel PlatformEvents / useTaskEvents bridge.

  // Same square the sidebar and project list draw, so the picker reads as a project.
  const projectOptions = projects.map(p => ({
    id: p.id,
    name: p.name,
    icon: (p.icon ? findColoredSquareIconByLabel(p.icon) : undefined) || FolderKanban,
    iconColor: p.color || coloredSquareColors[0].value,
  }));
  const projectById = Object.fromEntries(projects.map(p => [p.id, p]));

  const handleSaveTask = (data: SaveTaskFormData) => {
    // No project picked = a personal task (POST /tasks takes `projectId: null`).
    // It used to fall back to the first project, so personal tasks could not be
    // created at all.
    const selectedProject = data.linkedCompanyId ? projectById[data.linkedCompanyId] : undefined;

    startTransition(async () => {
      const result = await tasksApi.createGlobal({
        projectId: selectedProject?.id,
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        dueDate: data.dueDate?.toISOString(),
        duration: data.duration,
        labels: data.labels,
        assigneeId: data.assigneeId,
        assigneeIds: data.assigneeIds,
        repeat: data.repeat || undefined,
      });
      if (result.success && result.data) {
        const newTask = transformApiTask(result.data);
        fillNewTaskFromForm(newTask, data, selectedProject, availableAssignees);
        addOptimisticTask(newTask, 'end');
        setShowTaskDialog(false);
        setDialogDefaultStatus(undefined);
        toast.success(t.projects.myTasks.taskCreated);
        void queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
      } else {
        toast.error(result.error || t.projects.myTasks.taskCreateFailed);
      }
    });
  };

  const toggleTaskStatus = useCallback((taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    startTransition(async () => {
      const result = await tasksApi.toggleById(taskId, task.status);
      if (result.success) {
        setTasks(tasks.map((t) => {
          if (t.id === taskId) {
            const newStatus = t.status === 'done' ? 'todo' : 'done';
            return { ...t, status: newStatus };
          }
          return t;
        }));

        // If a next recurring task was created, fetch and add it
        if (result.data?.nextTaskId) {
          const nextResult = await tasksApi.getById(result.data.nextTaskId);
          const nextTask = nextResult.data;
          if (nextResult.success && nextTask) {
            addOptimisticTask(transformApiTask(nextTask), 'end');
            toast.success(t.projects.myTasks.nextRecurringCreated);
          }
        }

        void queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
      } else {
        toast.error(result.error || t.projects.myTasks.taskUpdateFailed);
      }
    });
  }, [tasks, startTransition, queryClient, t, addOptimisticTask]);

  const deleteTask = useCallback((taskId: string) => {
    startTransition(async () => {
      const result = await tasksApi.deleteById(taskId);
      if (result.success) {
        // The API deletes the task's subtasks with it. The refetch below keeps
        // rows the server no longer returns, so drop the subtree here.
        setTasks(prev => {
          const removedIds = new Set([taskId]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const row of prev) {
              if (row.parentTaskId && removedIds.has(row.parentTaskId) && !removedIds.has(row.id)) {
                removedIds.add(row.id);
                grew = true;
              }
            }
          }
          return prev.filter((row) => !removedIds.has(row.id));
        });
        toast.success(t.projects.myTasks.taskDeleted);
        void queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
      } else {
        toast.error(result.error || t.projects.myTasks.taskDeleteFailed);
      }
    });
  }, [startTransition, queryClient, t]);

  const handleStatusChange = useCallback(async (taskId: string, newStatus: Task['status']) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const oldStatus = task.status;

    // Optimistic update
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));

    // Use complete/uncomplete endpoints for done transitions (triggers recurring task creation)
    let result;
    if (newStatus === 'done' && oldStatus !== 'done') {
      result = await tasksApi.toggleById(taskId, oldStatus);
    } else if (newStatus !== 'done' && oldStatus === 'done') {
      result = await tasksApi.toggleById(taskId, 'done');
    } else {
      result = await tasksApi.updateById(taskId, { status: newStatus });
    }

    if (result.success) {
      // If a next recurring task was created, fetch and add it
      if (result.data?.nextTaskId) {
        const nextResult = await tasksApi.getById(result.data.nextTaskId);
        const nextTask = nextResult.data;
        if (nextResult.success && nextTask) {
          addOptimisticTask(transformApiTask(nextTask), 'end');
          toast.success(t.projects.myTasks.nextRecurringCreated);
        }
      }
      toast.success(t.projects.myTasks.taskMoved);
      void queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
    } else {
      // Rollback
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: oldStatus } : t));
      toast.error(t.projects.myTasks.taskMoveFailed);
    }
  }, [tasks, t, queryClient, addOptimisticTask]);

  const handlePipelineReorder = useCallback(async (columnStatus: string, reorderedTaskIds: string[]) => {
    // Optimistic update — reorder tasks within the column
    setTasks(prev => {
      const columnTasks = prev.filter(t => t.status === columnStatus);
      const otherTasks = prev.filter(t => t.status !== columnStatus);
      const reordered = reorderedTaskIds
        .map(id => columnTasks.find(t => t.id === id))
        .filter(Boolean) as Task[];
      return [...otherTasks, ...reordered];
    });

    // Group tasks by projectId for batch reorder
    const tasksByProject = new Map<string, string[]>();
    for (const taskId of reorderedTaskIds) {
      const task = tasks.find(t => t.id === taskId);
      if (task?.projectId) {
        const list = tasksByProject.get(task.projectId) || [];
        list.push(taskId);
        tasksByProject.set(task.projectId, list);
      }
    }

    // Persist via batch reorder per project
    for (const [projectId, taskIds] of tasksByProject) {
      const result = await tasksApi.reorderTasks(projectId, taskIds);
      if (!result.success) {
        toast.error(t.projects.myTasks.reorderFailed);
        break;
      }
    }
  }, [tasks, t]);

  const statusOrder = useMemo(() => ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done', 'cancelled'], []);
  const priorityOrder = useMemo(() => ['low', 'medium', 'high', 'urgent'], []);

  // Subtasks whose parent is loaded render under it; the rest are top-level rows.
  const { topLevelTasks, subtasksByParent } = useMemo(() => {
    const loadedIds = new Set(tasks.map((task) => task.id));
    const byParent: Record<string, Task[]> = {};
    const topLevel: Task[] = [];
    for (const task of tasks) {
      if (task.parentTaskId && loadedIds.has(task.parentTaskId)) {
        const siblings = byParent[task.parentTaskId] ?? [];
        siblings.push(task);
        byParent[task.parentTaskId] = siblings;
      } else if (!task.nestedOnly) {
        topLevel.push(task);
      }
    }
    return { topLevelTasks: topLevel, subtasksByParent: byParent };
  }, [tasks]);
  const boardTasks = useMemo(() => tasks.filter((task) => !task.nestedOnly), [tasks]);
  // Parents start expanded; this holds the ones the user folded.
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => new Set());
  const toggleExpandTask = useCallback((taskId: string) => {
    setCollapsedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const sortedTasks = useMemo(() => {
    if (!sortState) return topLevelTasks;
    const { columnId, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;

    const tiebreak = (a: Task, b: Task) => {
      const aTime = a.createdAt?.getTime?.() ?? 0;
      const bTime = b.createdAt?.getTime?.() ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.id.localeCompare(b.id);
    };

    return [...topLevelTasks].sort((a, b) => {
      let cmp = 0;
      switch (columnId) {
        case 'status':
          cmp = (statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)) * dir;
          break;
        case 'priority':
          cmp = (priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)) * dir;
          break;
        case 'dueDate': {
          const aTime = a.dueDate?.getTime() ?? Infinity;
          const bTime = b.dueDate?.getTime() ?? Infinity;
          cmp = (aTime - bTime) * dir;
          break;
        }
        case 'assignee': {
          const aName = (a.assignee || '').toLowerCase();
          const bName = (b.assignee || '').toLowerCase();
          cmp = aName.localeCompare(bName) * dir;
          break;
        }
        case 'project': {
          const aProject = (a.project || '').toLowerCase();
          const bProject = (b.project || '').toLowerCase();
          cmp = aProject.localeCompare(bProject) * dir;
          break;
        }
      }
      return cmp !== 0 ? cmp : tiebreak(a, b);
    });
  }, [topLevelTasks, sortState, statusOrder, priorityOrder]);

  // Table drag-and-drop handler — commit reorder on drop
  const handleTableDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortedTasks.findIndex(t => t.id === active.id);
    const newIndex = sortedTasks.findIndex(t => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(sortedTasks, oldIndex, newIndex);
    // Only top-level rows are sortable; keep the subtask rows after them.
    const topLevelIds = new Set(sortedTasks.map((task) => task.id));
    const subtaskRows = tasks.filter((task) => !topLevelIds.has(task.id));
    setTasks([...reordered, ...subtaskRows]);

    const tasksByProject = new Map<string, string[]>();
    for (const task of reordered) {
      if (task.projectId) {
        const list = tasksByProject.get(task.projectId) || [];
        list.push(task.id);
        tasksByProject.set(task.projectId, list);
      }
    }

    for (const [projectId, taskIds] of tasksByProject) {
      const result = await tasksApi.reorderTasks(projectId, taskIds);
      if (!result.success) {
        setTasks([...arrayMove(reordered, newIndex, oldIndex), ...subtaskRows]);
        toast.error(t.projects.myTasks.reorderFailed);
        break;
      }
    }
  }, [sortedTasks, tasks, t]);

  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const updateTaskInline = useCallback(async (taskId: string, data: Partial<Task>) => {
    const previous = tasksRef.current.find((row) => row.id === taskId);
    // Optimistic update
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...data } : t));
    setSelectedTask(prev => prev?.id === taskId ? { ...prev, ...data } : prev);

    const apiData = buildTaskUpdatePayload(data);

    // Prefer the project-scoped task update endpoint (which already supports
    // multi-assignees) when the task has a projectId; fall back to the
    // global endpoint for truly orphan tasks.
    const existingTask = previous;
    const projectId = existingTask?.projectId;
    const result = projectId
      ? await tasksApi.update(projectId, taskId, apiData)
      : await tasksApi.updateById(taskId, apiData);
    if (result.success) {
      void queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
    } else {
      // Rollback on failure: put back the previous value of exactly the fields
      // this edit touched (it used to delete them, leaving the row with no
      // priority or due date).
      if (previous) {
        const snapshot = Object.fromEntries(
          Object.keys(data).map((key) => [key, previous[key as keyof Task]]),
        ) as Partial<Task>;
        setTasks(prev => prev.map(row => (row.id === taskId ? { ...row, ...snapshot } : row)));
        setSelectedTask(prev => (prev?.id === taskId ? { ...prev, ...snapshot } : prev));
      }
      toast.error(t.projects.myTasks.taskUpdateFailed);
    }
  }, [queryClient, t]);

  const formatDateShort = useCallback((date: Date) => formatShort(date), [formatShort]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: t.projects.myTasks.filterStatus,
      options: [
        { value: 'backlog', label: t.projects.myTasks.statusLabels.backlog },
        { value: 'todo', label: t.projects.myTasks.statusLabels.todo },
        { value: 'in_progress', label: t.projects.myTasks.statusLabels.inProgress },
        { value: 'review', label: t.projects.myTasks.statusLabels.inReview },
        { value: 'testing', label: t.projects.myTasks.statusLabels.testing },
        { value: 'done', label: t.projects.myTasks.statusLabels.done },
        { value: 'cancelled', label: t.projects.myTasks.statusLabels.cancelled },
      ],
    },
    {
      field: 'priority',
      label: t.projects.myTasks.filterPriority,
      options: [
        { value: 'low', label: t.projects.myTasks.priorityLabels.low },
        { value: 'medium', label: t.projects.myTasks.priorityLabels.medium },
        { value: 'high', label: t.projects.myTasks.priorityLabels.high },
        { value: 'urgent', label: t.projects.myTasks.priorityLabels.urgent },
      ],
    },
    {
      field: 'project',
      label: t.projects.myTasks.filterProject,
      // The value is the id: the server's `projectId` filter takes an id.
      options: projects.map(p => ({ value: p.id, label: p.name })),
    },
    {
      field: 'label',
      label: t.projects.myTasks.filterLabel,
      options: availableLabels.map(l => ({ value: l.id, label: l.name })),
    },
  ], [projects, availableLabels, t]);

  // Group configs vary by the active "Group by" choice.
  const baseGroupConfigs: GroupConfig<Task>[] = useMemo(() => {
    if (groupBy === 'none') return [];

    if (groupBy === 'priority') {
      return [
        { id: 'critical', label: t.projects.myTasks.priorityLabels.critical, sortOrder: 0, filter: (task) => (task.priority as string) === 'critical' },
        { id: 'urgent', label: t.projects.myTasks.priorityLabels.urgent, sortOrder: 1, filter: (task) => task.priority === 'urgent' },
        { id: 'high', label: t.projects.myTasks.priorityLabels.high, sortOrder: 2, filter: (task) => task.priority === 'high' },
        { id: 'medium', label: t.projects.myTasks.priorityLabels.medium, sortOrder: 3, filter: (task) => task.priority === 'medium' },
        { id: 'low', label: t.projects.myTasks.priorityLabels.low, sortOrder: 4, filter: (task) => task.priority === 'low' },
      ];
    }

    if (groupBy === 'dueDate') {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const startOfTomorrow = new Date(startOfToday);
      startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
      const startOfNextWeek = new Date(startOfToday);
      startOfNextWeek.setDate(startOfNextWeek.getDate() + 7);
      return [
        { id: 'overdue', label: t.projects.myTasks.groupLabels.overdue, sortOrder: 1, filter: (task) => !!task.dueDate && task.dueDate < startOfToday },
        { id: 'today', label: t.projects.myTasks.groupLabels.today, sortOrder: 2, filter: (task) => !!task.dueDate && task.dueDate >= startOfToday && task.dueDate < startOfTomorrow },
        { id: 'thisWeek', label: t.projects.myTasks.groupLabels.thisWeek, sortOrder: 3, filter: (task) => !!task.dueDate && task.dueDate >= startOfTomorrow && task.dueDate < startOfNextWeek },
        { id: 'later', label: t.projects.myTasks.groupLabels.later, sortOrder: 4, filter: (task) => !!task.dueDate && task.dueDate >= startOfNextWeek },
        { id: 'no-date', label: t.projects.myTasks.groupLabels.noDueDate, sortOrder: 5, filter: (task) => !task.dueDate },
      ];
    }

    if (groupBy === 'project') {
      const projectGroups: GroupConfig<Task>[] = projects.map((p, i) => ({
        id: `project-${p.id}`,
        label: p.name,
        sortOrder: i + 1,
        filter: (task: Task) => task.projectId === p.id || task.project === p.name,
      }));
      projectGroups.push({
        id: 'no-project',
        label: t.projects.myTasks.groupLabels.noProject,
        sortOrder: projects.length + 1,
        filter: (task) => !task.projectId && !task.project,
      });
      return projectGroups;
    }

    return [
      { id: 'backlog', label: t.projects.myTasks.statusLabels.backlog, sortOrder: 1, filter: (task) => task.status === 'backlog' },
      { id: 'todo', label: t.projects.myTasks.statusLabels.todo, sortOrder: 2, filter: (task) => task.status === 'todo' },
      { id: 'in_progress', label: t.projects.myTasks.statusLabels.inProgress, sortOrder: 3, filter: (task) => task.status === 'in_progress' },
      { id: 'review', label: t.projects.myTasks.statusLabels.inReview, sortOrder: 4, filter: (task) => task.status === 'review' },
      { id: 'testing', label: t.projects.myTasks.statusLabels.testing, sortOrder: 5, filter: (task) => task.status === 'testing' },
      { id: 'done', label: t.projects.myTasks.statusLabels.done, sortOrder: 6, filter: (task) => task.status === 'done' },
      { id: 'cancelled', label: t.projects.myTasks.statusLabels.cancelled, sortOrder: 7, filter: (task) => task.status === 'cancelled' },
    ];
  }, [groupBy, projects, t]);

  // A task matching no group (e.g. a status or project that isn't listed) would
  // vanish from the list, so the leftovers get a catch-all group.
  const groupConfigs: GroupConfig<Task>[] = useMemo(
    () => withOtherGroup(baseGroupConfigs, t.projects.myTasks.groupLabels.other),
    [baseGroupConfigs, t.projects.myTasks.groupLabels.other],
  );

  const groupByOptions = useMemo(() => [
    { value: 'status' as const, label: t.projects.myTasks.groupByStatus },
    { value: 'priority' as const, label: t.projects.myTasks.groupByPriority },
    { value: 'dueDate' as const, label: t.projects.myTasks.groupByDueDate },
    { value: 'project' as const, label: t.projects.myTasks.groupByProject },
    { value: 'none' as const, label: t.projects.myTasks.groupByNone },
  ], [t]);
  const groupByLabel = groupByOptions.find(o => o.value === groupBy)?.label ?? 'Status';

  const groupByMenu = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-sm px-3 shadow-none text-muted-foreground"
        >
          {groupByLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {groupByOptions.map(opt => (
          <Button
            key={opt.value}
            type="button"
            variant="ghost"
            onClick={() => setGroupBy(opt.value)}
            className={cn(
              'w-full flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-muted',
              groupBy === opt.value && 'bg-muted'
            )}
          >
            <span>{opt.label}</span>
            {groupBy === opt.value && <Check className="h-3.5 w-3.5" />}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );

  // Apply filters
  const applyFilters = useCallback((items: Task[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(t => t.status === filter.value)
          : result.filter(t => t.status !== filter.value);
      } else if (filter.field === 'priority') {
        result = filter.operator === 'is'
          ? result.filter(t => t.priority === filter.value)
          : result.filter(t => t.priority !== filter.value);
      } else if (filter.field === 'project') {
        result = filter.operator === 'is'
          ? result.filter(t => t.projectId === filter.value)
          : result.filter(t => t.projectId !== filter.value);
      } else if (filter.field === 'label') {
        result = filter.operator === 'is'
          ? result.filter(t => Array.isArray(t.labels) && t.labels.includes(filter.value))
          : result.filter(t => !Array.isArray(t.labels) || !t.labels.includes(filter.value));
      }
    });
    return result;
  }, []);

  // With the page driving the filters, EntityList does not run `applyFilters`
  // itself. The server takes "is" filters and "status is not"; the other
  // "is not" filters only exist here, so apply them to the loaded rows.
  const visibleTasks = useMemo(() => {
    const negated = (activeFiltersProp ?? []).filter((f) => f.operator === 'is not' && f.field !== 'status');
    return negated.length > 0 ? applyFilters(sortedTasks, negated) : sortedTasks;
  }, [activeFiltersProp, sortedTasks, applyFilters]);

  const handleSort = useCallback((columnId: string) => {
    setSortState(prev => {
      if (prev?.columnId === columnId) {
        if (prev.direction === 'asc') return { columnId, direction: 'desc' as const };
        return null;
      }
      return { columnId, direction: 'asc' as const };
    });
  }, [setSortState]);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'checkbox', header: t.projects.tasks.task, width: 'w-4 flex-shrink-0' },
    { id: 'task', header: '', width: 'min-w-[200px] flex-1' },
    { id: 'project', header: t.projects.myTasks.columns.project, width: 'w-[140px]', sortable: true },
    { id: 'status', header: t.projects.myTasks.columns.status, width: 'w-[120px]', sortable: true },
    { id: 'priority', header: t.projects.myTasks.columns.priority, width: 'w-[100px]', sortable: true },
    { id: 'dueDate', header: t.projects.myTasks.columns.due, width: 'w-[100px]', sortable: true },
    { id: 'assignee', header: t.projects.myTasks.columns.assignee, width: 'w-[120px]', sortable: true },
  ], [t]);

  // Render row content (reused for top-level and subtask rows). `depth` is the
  // nesting level of a subtask (0 = direct child of a top-level row); it's
  // folded into paddingLeft so the hover background covers the full width.
  const renderTaskRow = useCallback((task: Task, depth?: number) => {
    const status = statusConfig[task.status] || statusConfig.todo;
    const priority = priorityConfig[task.priority] || priorityConfig.medium;
    const isSubtask = depth !== undefined;
    const hasSubtasks = (subtasksByParent[task.id]?.length ?? 0) > 0;
    const isExpanded = !collapsedTaskIds.has(task.id);

    return (
      <div
        key={task.id}
        className={cn(
          "relative flex items-center gap-4 py-3 pr-4 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer group",
          !isSubtask && "border-b border-gray-200/70 dark:border-border",
          task.status === 'done' && "opacity-50"
        )}
        style={{ paddingLeft: isSubtask ? 48 + depth * 32 : 16 }}
      >
        {/* Row click target: stretched button; interactive cells sit above it */}
        <button
          type="button"
          aria-label={task.title}
          onClick={() => openTask(task)}
          className="absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        {/* Checkbox */}
        <div className="relative z-[1] flex w-4 flex-shrink-0 items-center">
          <Checkbox
            checked={task.status === 'done'}
            onCheckedChange={() => toggleTaskStatus(task.id)}
            disabled={isPending}
            className="h-4 w-4"
          />
        </div>

        {/* Task Title */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2">
          {task.number != null && (
            <TaskNumberBadge number={task.number} className="h-[18px] flex-shrink-0 py-0" />
          )}
          <span className={cn(
            "text-sm font-medium truncate min-w-0",
            task.status === 'done' ? "line-through text-gray-400" : "text-gray-900 dark:text-foreground"
          )}>
            {task.title}
          </span>
          {hasSubtasks && (
            <Button
              variant="ghost"
              aria-label={isExpanded ? t.projects.myTasks.collapseSubtasks : t.projects.myTasks.expandSubtasks}
              aria-expanded={isExpanded}
              onClick={(e) => { e.stopPropagation(); toggleExpandTask(task.id); }}
              className="relative z-[1] h-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-gray-200 dark:hover:bg-gray-700 transition-[opacity,color,background-color] flex-shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <ChevronRight className={cn("h-3.5 w-3.5", isExpanded && "rotate-90")} />
            </Button>
          )}
          {task.labels && task.labels.length > 0 && (
            <LabelOverflowList
              labels={task.labels
                .map((labelId) => availableLabels.find((l) => l.id === labelId))
                .filter((l): l is NonNullable<typeof l> => !!l)
                .map((l) => ({ id: l.id, name: l.name, color: l.color }))}
            />
          )}
          {task.repeat && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 flex-shrink-0">
              <Repeat className="h-2.5 w-2.5" />
              {formatRepeatBadge(task.repeat)}
            </span>
          )}
        </div>

        {/* Project */}
        <div className="flex w-[140px] items-center">
          {task.project ? (
            <span className="text-sm text-gray-600 dark:text-muted-foreground truncate block">{task.project}</span>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        {/* Status */}
        <div className="relative z-[1] flex w-[120px] items-center">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn("h-auto px-2 py-0.5 rounded text-[12px] font-medium cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow", status.color, status.bg)}>
                {status.label}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {Object.entries(statusConfig).map(([key, config]) => (
                <Button
                  key={key}
                  variant="ghost"
                  onClick={() => handleStatusChange(task.id, key as Task['status'])}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4"
                >
                  <span>{config.label}</span>
                  {task.status === key && <Check className="h-3.5 w-3.5 text-primary" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {/* Priority */}
        <div className="relative z-[1] flex w-[100px] items-center">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn("h-auto px-2 py-0.5 rounded text-[12px] font-medium cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow", priority.color, priority.bg)}>
                {priority.label}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {Object.entries(priorityConfig).map(([key, config]) => (
                <Button
                  key={key}
                  variant="ghost"
                  onClick={() => updateTaskInline(task.id, { priority: key as Task['priority'] })}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4"
                >
                  <span>{config.label}</span>
                  {task.priority === key && <Check className="h-3.5 w-3.5 text-primary" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {/* Due Date */}
        <div className="relative z-[1] flex w-[100px] items-center">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="h-auto text-sm cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded px-1 py-0.5 transition-shadow">
                {task.dueDate ? (
                  <span className="font-mono text-gray-600 dark:text-muted-foreground">{formatDateShort(task.dueDate)}</span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={task.dueDate}
                onSelect={(date) => updateTaskInline(task.id, { dueDate: date || undefined })}
                autoFocus
              />
              {task.dueDate && (
                <div className="p-1 border-t border-border">
                  <Button
                    variant="ghost"
                    onClick={() => updateTaskInline(task.id, { dueDate: undefined })}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    <span>{t.projects.myTasks.clear}</span>
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Assignee(s) */}
        <div className="relative z-[1] flex w-[120px] items-center">
          {(() => {
            // Derive full assignee list from assigneeIds + availableAssignees directory.
            // Falls back to enriched `assignees` or the single assignee when needed.
            const resolvedIds: string[] = (() => {
              if (task.assigneeIds && task.assigneeIds.length > 0) return task.assigneeIds;
              if (task.assignees && task.assignees.length > 0) return task.assignees.map((a) => a.id);
              if (task.assigneeId) return [task.assigneeId];
              return [];
            })();

            const resolvedList = resolvedIds.map((id) => {
              const fromDirectory = availableAssignees.find((m) => m.id === id);
              const fromAssignees = task.assignees?.find((a) => a.id === id);
              return {
                id,
                name: fromDirectory?.name || fromAssignees?.name || (id === task.assigneeId ? task.assignee : '') || t.common.labels.unknown,
                avatar: fromDirectory?.avatar || fromAssignees?.avatar,
              };
            });

            const multiple = resolvedList.length > 1;

            return (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    className={cn(
                      'h-auto cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded-[6px] pl-0.5 py-0.5 transition-shadow',
                      multiple ? 'pr-0.5' : 'pr-1.5',
                    )}
                  >
                    {resolvedList.length > 0 ? (
                      <div className="flex items-center">
                        <div className="flex -space-x-1.5">
                          {resolvedList.slice(0, 3).map((a) => {
                            const avatar = (
                              <Avatar
                                key={a.id}
                                className="h-5 w-5 !rounded-[7px] ring-1 ring-background"
                                title={multiple ? undefined : a.name}
                              >
                                {a.avatar && <AvatarImage src={a.avatar} alt={a.name} className="!rounded-[7px]" />}
                                <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                                  {(a.name || '?').charAt(0).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                            );
                            if (!multiple) return avatar;
                            return (
                              <Tooltip key={a.id} delayDuration={150}>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">{avatar}</span>
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={4}>
                                  {a.name}
                                </TooltipContent>
                              </Tooltip>
                            );
                          })}
                          {resolvedList.length > 3 && (
                            <div className="relative z-10 w-5 h-5 rounded-[7px] bg-[#dcdce0] dark:bg-accent flex items-center justify-center ring-1 ring-background">
                              <span className="text-[9.5px] font-mono font-medium text-gray-600 dark:text-muted-foreground">
                                +{resolvedList.length - 3}
                              </span>
                            </div>
                          )}
                        </div>
                        {!multiple && (
                          <span className="text-sm text-gray-600 dark:text-muted-foreground truncate ml-1.5">
                            {resolvedList[0]!.name.split(' ')[0]}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400">—</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-1" align="start">
                  {availableAssignees.map((member) => {
                    const isSelected = resolvedIds.includes(member.id);
                    return (
                      <Button
                        key={member.id}
                        variant="ghost"
                        onClick={() =>
                          updateTaskInline(
                            task.id,
                            buildAssigneeToggleUpdate(resolvedIds, member.id, isSelected, availableAssignees),
                          )
                        }
                        className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4"
                      >
                        <span className="flex items-center gap-2">
                          <Avatar className="h-5 w-5 !rounded-[7px]">
                            {member.avatar && (
                              <AvatarImage src={member.avatar} alt={member.name} className="!rounded-[7px]" />
                            )}
                            <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                              {member.name.charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span>{member.name}</span>
                        </span>
                        {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                      </Button>
                    );
                  })}
                  {resolvedList.length > 0 && (
                    <>
                      <div className="h-px bg-border my-1" />
                      <Button
                        variant="ghost"
                        onClick={() => updateTaskInline(task.id, { assigneeId: undefined, assignee: undefined, assigneeIds: [], assignees: [] })}
                        className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        <span>{t.projects.myTasks.clear}</span>
                      </Button>
                    </>
                  )}
                </PopoverContent>
              </Popover>
            );
          })()}
        </div>

        {/* Actions */}
        <div className="relative z-[1] w-[40px] flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => {
                setEditingCrmTask(toCrmTask(task));
                setShowTaskDialog(true);
              }}>
                <Pencil className="h-3.5 w-3.5 mr-0.5" />
                {t.projects.myTasks.edit}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                startTransition(async () => {
                  const result = await tasksApi.createGlobal({
                    projectId: task.projectId,
                    title: `${task.title} ${t.projects.myTasks.copySuffix}`,
                    description: task.description,
                    status: task.status,
                    priority: task.priority,
                    dueDate: task.dueDate?.toISOString(),
                    startDate: task.startDate?.toISOString(),
                    duration: task.duration,
                    assigneeIds: task.assigneeIds ?? (task.assigneeId ? [task.assigneeId] : undefined),
                    labels: task.labels,
                    repeat: task.repeat || undefined,
                  });
                  if (result.success && result.data) {
                    const newTask = transformApiTask(result.data);
                    if (!newTask.project && task.project) {
                      newTask.project = task.project;
                      newTask.projectId = task.projectId;
                    }
                    addOptimisticTask(newTask, 'end');
                    toast.success(t.projects.myTasks.taskDuplicated);
                    void queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
                  } else {
                    toast.error(t.projects.myTasks.taskDuplicateFailed);
                  }
                });
              }}>
                <Copy className="h-3.5 w-3.5 mr-0.5" />
                {t.projects.myTasks.duplicate}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950" onClick={() => setPendingDeleteId(task.id)}>
                <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-600" />
                {t.projects.myTasks.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [isPending, toggleTaskStatus, availableLabels, handleStatusChange, updateTaskInline, availableAssignees, formatDateShort, startTransition, queryClient, t, openTask, addOptimisticTask, priorityConfig, statusConfig, subtasksByParent, collapsedTaskIds, toggleExpandTask]);

  // Recursively render a task's subtasks under it, with the same tree guides
  // as the project task list. Each row and its own descendants live in sibling
  // wrappers so a row's guide lines stay bounded to that row's height.
  const renderSubtaskList = useCallback((parent: Task, depth: number): React.ReactNode => {
    const childTasks = subtasksByParent[parent.id];
    if (!childTasks || childTasks.length === 0) return null;
    const guideLeft = 22 + depth * 32;
    return (
      <div hidden={collapsedTaskIds.has(parent.id)}>
        {childTasks.map((sub, index) => {
          const isLast = index === childTasks.length - 1;
          const nestedContent = renderSubtaskList(sub, depth + 1);
          return (
            <React.Fragment key={sub.id}>
              <div className="relative border-b border-gray-200/70 dark:border-border">
                <div style={{ position: 'absolute', left: guideLeft, top: 0, height: 'calc(50% - 5px)', width: 1, backgroundColor: 'var(--color-border)', zIndex: 1 }} />
                <div style={{ position: 'absolute', left: guideLeft, top: 'calc(50% - 6px)', width: 15, height: 8, borderLeft: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)', borderRadius: '0 0 0 6px', zIndex: 1 }} />
                {!isLast && (
                  <div style={{ position: 'absolute', left: guideLeft, top: 'calc(50% + 2px)', bottom: 0, width: 1, backgroundColor: 'var(--color-border)', zIndex: 1 }} />
                )}
                {renderTaskRow(sub, depth)}
              </div>
              {nestedContent && (
                <div className="relative">
                  {!isLast && (
                    <div style={{ position: 'absolute', left: guideLeft, top: 0, bottom: 0, width: 1, backgroundColor: 'var(--color-border)', zIndex: 1 }} />
                  )}
                  {nestedContent}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    );
  }, [subtasksByParent, collapsedTaskIds, renderTaskRow]);

  // Render row (wraps content with sortable when drag is enabled)
  const renderRow = useCallback((task: Task) => {
    const rowContent = (
      <React.Fragment key={task.id}>
        {renderTaskRow(task)}
        {renderSubtaskList(task, 0)}
      </React.Fragment>
    );

    if (isDragEnabled) {
      return (
        <SortableTaskRow key={task.id} id={task.id} isDragEnabled={isDragEnabled}>
          {rowContent}
        </SortableTaskRow>
      );
    }

    return rowContent;
  }, [renderTaskRow, renderSubtaskList, isDragEnabled]);

  const viewToggle = (
    <div className="flex items-center border bg-background dark:bg-input/30 dark:border-input rounded-md overflow-hidden shadow-none">
      <Button
        variant="ghost"
        onClick={() => setViewMode('list')}
        className={cn(
          "h-[30px] w-8 flex items-center justify-center transition-colors",
          viewMode === 'list'
            ? "bg-accent text-accent-foreground dark:bg-input/50"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50"
        )}
        title={t.projects.myTasks.listView}
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        onClick={() => setViewMode('pipeline')}
        className={cn(
          "h-[30px] w-8 flex items-center justify-center transition-colors",
          viewMode === 'pipeline'
            ? "bg-accent text-accent-foreground dark:bg-input/50"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50"
        )}
        title={t.projects.myTasks.boardView}
      >
        <Columns3 className="h-4 w-4" />
      </Button>
    </div>
  );

  const loadMoreSentinel = (
    <>
      <div ref={loadMoreRef} />
      {isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
        </div>
      )}
    </>
  );

  return (
    <>
      {viewMode === 'list' ? (
        <>
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleTableDragEnd}
        >
          <SortableContext
            items={sortedTasks.map(t => t.id)}
            strategy={verticalListSortingStrategy}
          >
            <EntityList<Task>
              items={visibleTasks}
              isLoading={false}
              error={null}
              headerColumns={headerColumns}
              filters={filterConfigs}
              groups={groupConfigs}
              maxFilters={5}
              applyFilters={applyFilters}
              renderRow={renderRow}
              searchPlaceholder={t.projects.myTasks.searchPlaceholder}
              searchFields={['title', 'description', 'assignee', 'project']}
              sortState={sortState}
              onSort={handleSort}
              searchQuery={searchQueryProp}
              onSearchChange={onSearchChange}
              activeFilters={activeFiltersProp}
              onFiltersChange={onFiltersChange}
              hasMore={hasNextPage}
              isLoadingMore={isFetchingNextPage}
              onLoadMore={onLoadMore}
              topBarClassName="pt-2 pb-2"
          stickyOffset={-16}
          leftActionButtons={<>{groupByMenu}{viewToggle}</>}
          createButton={{
            label: t.projects.myTasks.newTask,
            onClick: () => setShowTaskDialog(true),
          }}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <svg width="120" height="140" viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}>
                  {/* Clipboard body */}
                  <rect x="16" y="22" width="80" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
                  <rect x="16" y="22" width="80" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                  <rect x="16" y="22" width="80" height="12" rx="6" className="fill-gray-50/60 dark:fill-white/[0.06]" />
                  {/* Clipboard clip */}
                  <rect x="38" y="14" width="36" height="16" rx="4" className="fill-gray-50 dark:fill-white/15" />
                  <rect x="38" y="14" width="36" height="16" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                  <rect x="48" y="18" width="16" height="4" rx="2" className="fill-gray-200 dark:fill-white/20" />
                  {/* Row 1 - checked */}
                  <rect x="28" y="46" width="14" height="14" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" fill="none" />
                  <path d="M32 53L34 55.5L38 50.5" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <rect x="48" y="50" width="36" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
                  <rect x="48" y="56" width="24" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.5" />
                  {/* Row 2 - checked */}
                  <rect x="28" y="68" width="14" height="14" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" fill="none" />
                  <path d="M32 75L34 77.5L38 72.5" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <rect x="48" y="72" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
                  <rect x="48" y="78" width="20" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.5" />
                  {/* Row 3 - unchecked */}
                  <rect x="28" y="90" width="14" height="14" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" fill="none" />
                  <rect x="48" y="94" width="28" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.4" />
                  <rect x="48" y="100" width="18" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.3" />
                </svg>
              </EmptyStateIllustration>
            ),
            title: t.projects.myTasks.noTasks,
            description: t.projects.myTasks.noTasksDescription,
            action: {
              label: t.projects.myTasks.newTask,
              onClick: () => setShowTaskDialog(true),
            },
          }}
          noResultsState={{
            title: t.projects.myTasks.noResultsTitle,
            description: t.projects.myTasks.noResultsDescription,
          }}
        />
          </SortableContext>
        </DndContext>
        {loadMoreSentinel}
        </>
      ) : (
        <>
          <MyTasksPipeline
            tasks={boardTasks}
            availableLabels={availableLabels}
            filterConfigs={filterConfigs}
            onTaskClick={openTask}
            onStatusChange={handleStatusChange}
            onReorder={handlePipelineReorder}
            onCreateTask={(status) => {
              // Preset the dialog's status to the column "New Task" was clicked in.
              setDialogDefaultStatus(status);
              setShowTaskDialog(true);
            }}
            viewToggle={viewToggle}
          />
          {loadMoreSentinel}
        </>
      )}

      <TaskDialog
        open={showTaskDialog}
        onOpenChange={(open) => {
          setShowTaskDialog(open);
          if (!open) {
            setEditingCrmTask(null);
            setDialogDefaultStatus(undefined);
          }
        }}
        editingTask={editingCrmTask}
        availableAssignees={availableAssignees}
        availableCompanies={projectOptions}
        availableLabels={availableLabels}
        onCreateLabel={handleCreateLabel}
        defaultAssignee={userId || undefined}
        defaultStatus={dialogDefaultStatus}
        recordLabel={t.projects.myTasks.selectProject}
        recordSearchPlaceholder={t.projects.project.searchProjects}
        recordEmptyLabel={t.projects.project.noProjects}
        onSave={handleSaveTask}
        onUpdate={(taskId, data) => {
          const projectData: TaskUpdatePayload = {};
          // The same edit in the shape the list rows hold (a Date, not the ISO
          // string the API takes), so a saved date keeps grouping and filtering.
          const localPatch: Partial<Task> = {};
          if (data.title) {
            projectData.title = data.title;
            localPatch.title = data.title;
          }
          if (data.description !== undefined) {
            projectData.description = data.description || null;
            localPatch.description = data.description || undefined;
          }
          if (data.status) {
            const status = statusFromCrm[data.status] || data.status;
            projectData.status = status;
            localPatch.status = status as Task['status'];
          }
          if (data.priority) {
            projectData.priority = data.priority;
            localPatch.priority = data.priority;
          }
          if (data.dueDate !== undefined) {
            projectData.dueDate = data.dueDate ? data.dueDate.toISOString() : null;
            localPatch.dueDate = data.dueDate ?? undefined;
          }
          // Only a changed duration is sent: the dialog echoes the current value
          // back on every save, and a write re-plans the task's calendar block.
          if (data.duration !== undefined && data.duration !== editingCrmTask?.duration) {
            projectData.duration = data.duration;
            localPatch.duration = data.duration;
          }
          if (data.labels !== undefined) {
            projectData.labels = data.labels;
            localPatch.labels = data.labels;
          }
          if (data.repeat !== undefined) {
            projectData.repeat = data.repeat;
            localPatch.repeat = data.repeat;
          }
          if (data.assigneeIds !== undefined) {
            projectData.assigneeIds = data.assigneeIds;
            const resolved = data.assigneeIds.map((id) => {
              const member = availableAssignees.find((m) => m.id === id);
              return { id, name: member?.name ?? '', avatar: member?.avatar };
            });
            localPatch.assigneeIds = data.assigneeIds;
            localPatch.assigneeId = data.assigneeIds[0];
            localPatch.assignees = resolved;
            localPatch.assignee = resolved[0]?.name;
          }

          startTransition(async () => {
            const result = await tasksApi.updateById(taskId, projectData);
            if (result.success) {
              setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...localPatch } : t));
              setSelectedTask(prev => prev?.id === taskId ? { ...prev, ...localPatch } : prev);
              setShowTaskDialog(false);
              setDialogDefaultStatus(undefined);
              setEditingCrmTask(null);
              toast.success(t.projects.myTasks.taskUpdated);
              void queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
            } else {
              toast.error(t.projects.myTasks.taskUpdateFailed);
            }
          });
        }}
        isPending={isPending}
      />

      {/* Subtask Dialog */}
      <TaskDialog
        open={showSubtaskDialog}
        onOpenChange={setShowSubtaskDialog}
        editingTask={null}
        availableAssignees={availableAssignees}
        availableCompanies={projectOptions}
        availableLabels={availableLabels}
        onCreateLabel={handleCreateLabel}
        defaultAssignee={userId || undefined}
        hideRecord
        recordLabel={t.projects.myTasks.selectProject}
        recordSearchPlaceholder={t.projects.project.searchProjects}
        recordEmptyLabel={t.projects.project.noProjects}
        onSave={handleSaveSubtask}
        onUpdate={() => {}}
        isPending={isPending}
      />

      <ConfirmDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}
        title={st('sweep.entities.deleteTask')}
        description={st('sweep.entities.deleteTaskConfirmDescription')}
        confirmLabel={st('sweep.entities.deleteTask')}
        cancelLabel={st('common.actions.cancel')}
        variant="destructive"
        onConfirm={() => {
          if (pendingDeleteId) deleteTask(pendingDeleteId);
          setPendingDeleteId(null);
        }}
      />

      {/* Task detail panel is now rendered globally via ObjectPanelHost. */}
    </>
  );
}
