
import React, { useState, useMemo, useTransition, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useUser } from '@clerk/clerk-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { useTaskEvents } from '@/hooks/realtime/use-entity-events';
import type { TaskEventData, AnyPlatformEvent } from '@/lib/platform-events/types';
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
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { type TaskComment, type SubtaskItem, type DependencyTask } from '@/components/task-detail';
import { useObjectPanel } from '@/components/object-panel';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { tasksApi, membersApi, labelsApi } from '../lib/api-client';
import { LabelOverflowList } from '../lib/label-overflow-list';
import type { Projects } from '@/lib/api/types/apps/projects.types';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type RowHandlers, type SortState } from '@/components/entity-list';
import { MyTasksPipeline } from './my-tasks-pipeline';

interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'testing' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
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
  in_review: { icon: Clock, color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950' },
  testing: { icon: Clock, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
  done: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  cancelled: { icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

// Transform API task to local Task format
function transformApiTask(apiTask: Projects.ProjectTask): Task {
  return {
    id: apiTask.id,
    title: apiTask.title,
    description: apiTask.description || undefined,
    status: (apiTask.status as Task['status']) || 'todo',
    priority: (apiTask.priority as Task['priority']) || 'medium',
    assignee: apiTask.assignee?.name || undefined,
    assigneeId: apiTask.assigneeId || undefined,
    assigneeIds: apiTask.assigneeIds && apiTask.assigneeIds.length > 0
      ? apiTask.assigneeIds
      : apiTask.assigneeId
        ? [apiTask.assigneeId]
        : undefined,
    assignees: apiTask.assignees
      ? apiTask.assignees.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar }))
      : undefined,
    dueDate: apiTask.dueDate ? new Date(apiTask.dueDate) : undefined,
    startDate: (apiTask as any).startDate ? new Date((apiTask as any).startDate) : undefined,
    duration: (apiTask as any).duration ?? undefined,
    estimatedHours: (apiTask as any).estimatedHours ?? undefined,
    createdAt: new Date(apiTask.createdAt),
    project: apiTask.project?.name || undefined,
    projectId: apiTask.projectId || undefined,
    tags: apiTask.tags || undefined,
    labels: apiTask.labels || undefined,
    parentTaskId: (apiTask as any).parentTaskId || null,
    repeat: (apiTask as any).repeat || null,
  };
}

// Map project status to CRM status format (now 1:1 since CRM uses same statuses)
const statusToCrm: Record<string, CrmTask['status']> = {
  'backlog': 'backlog',
  'todo': 'todo',
  'in_progress': 'in_progress',
  'in_review': 'in_review',
  'testing': 'testing',
  'done': 'done',
  'cancelled': 'cancelled',
};

const statusFromCrm: Record<string, Task['status']> = {
  'backlog': 'backlog',
  'todo': 'todo',
  'in_progress': 'in_progress',
  'in_review': 'in_review',
  'testing': 'testing',
  'done': 'done',
  'cancelled': 'cancelled',
};

function toCrmTask(task: Task): CrmTask {
  // Build the multi-assignee array the panel actually renders. Without this,
  // the panel only ever sees the singular `assignee` and the picker can't
  // mark additional users as selected even though they're stored on the task.
  const assigneesList = task.assignees && task.assignees.length > 0
    ? task.assignees.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar }))
    : task.assigneeId && task.assignee
      ? [{ id: task.assigneeId, name: task.assignee }]
      : [];
  const primary = assigneesList[0];
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: statusToCrm[task.status] || 'todo',
    priority: task.priority === 'urgent' ? 'high' : (task.priority as CrmTask['priority']),
    assignee: primary,
    assignees: assigneesList,
    dueDate: task.dueDate,
    createdAt: task.createdAt,
    labels: task.labels,
    repeat: task.repeat || undefined,
    scheduledStart: task.scheduledStart ? new Date(task.scheduledStart) : null,
    scheduledEnd: task.scheduledEnd ? new Date(task.scheduledEnd) : null,
    autoScheduled: task.autoScheduled ?? null,
    linkedCompany: task.projectId ? { id: task.projectId, name: task.project ?? '' } : null,
  };
}

const restrictToVerticalAxis = ({ transform }: { transform: { x: number; y: number; scaleX: number; scaleY: number } }) => ({
  ...transform,
  x: 0,
});

function SortableTaskRow({ id, isDragEnabled, children }: { id: string; isDragEnabled: boolean; children: React.ReactNode }) {
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

  // Dragged row snaps to the target slot. Non-dragged rows use dnd-kit's own shift
  // transform so they fill the gap the dragged row leaves behind. We override transition
  // for both so they share the exact same timing and never cross paths mid-animation.
  const snapY =
    isDragging && rect.current && activeIndex !== -1
      ? ((overIndex !== -1 ? overIndex : activeIndex) - activeIndex) * rect.current.height
      : 0;

  // Only apply drag-related layout styles while a sort is in progress. When idle, leave
  // the row completely alone so there are no stray stacking contexts or transitions that
  // could flicker during normal hover.
  const style: React.CSSProperties = isSorting
    ? {
        transform: isDragging
          ? `translate3d(0, ${snapY}px, 0)`
          : CSS.Transform.toString(transform),
        transition: 'transform 150ms cubic-bezier(0.2, 0, 0, 1)',
        position: 'relative',
        zIndex: isDragging ? 50 : undefined,
        backgroundColor: isDragging ? 'var(--background)' : undefined,
        cursor: isDragEnabled ? 'grabbing' : undefined,
      }
    : {
        cursor: isDragEnabled ? 'grab' : undefined,
      };

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
}: MyTasksClientProps) {
  const { t } = useI18n();
  const { user } = useUser();
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
    in_review: { label: t.projects.myTasks.statusLabels.inReview, ...statusConfigBase.in_review },
    testing: { label: t.projects.myTasks.statusLabels.testing, ...statusConfigBase.testing },
    done: { label: t.projects.myTasks.statusLabels.done, ...statusConfigBase.done },
    cancelled: { label: t.projects.myTasks.statusLabels.cancelled, ...statusConfigBase.cancelled },
  }), [t]);

  const [tasks, setTasks] = useState<Task[]>(initialTasks.map(transformApiTask));
  const prevInitialTasksRef = useRef(initialTasks);
  useEffect(() => {
    if (prevInitialTasksRef.current !== initialTasks) {
      prevInitialTasksRef.current = initialTasks;
      setTasks((prev) => {
        const fresh = initialTasks.map(transformApiTask);
        const freshById = new Map(fresh.map((f) => [f.id, f]));
        const prevById = new Map(prev.map((p) => [p.id, p]));

        // Walk fresh in server order so the displayed order always matches the
        // server's deterministic ORDER BY. For each fresh row, merge in any
        // optimistic-only fields from the prev copy. Then append prev rows the
        // server hasn't echoed yet (just-created, replica lag) so they don't
        // blink out — platform events / explicit deletes remove them when the
        // server catches up.
        const merged: Task[] = fresh.map((f) => {
          const p = prevById.get(f.id);
          if (!p) return f;
          const out: Task = { ...f };
          if ((f.assigneeIds?.length ?? 0) < (p.assigneeIds?.length ?? 0)) {
            out.assigneeIds = p.assigneeIds;
          }
          if ((f.assignees?.length ?? 0) < (p.assignees?.length ?? 0)) {
            out.assignees = p.assignees;
          }
          if (out.duration == null && p.duration != null) out.duration = p.duration;
          if (out.estimatedHours == null && p.estimatedHours != null) out.estimatedHours = p.estimatedHours;
          if (out.startDate == null && p.startDate != null) out.startDate = p.startDate;
          if (out.dueDate == null && p.dueDate != null) out.dueDate = p.dueDate;
          if (out.priority == null && p.priority != null) out.priority = p.priority;
          if ((!out.labels || out.labels.length === 0) && p.labels?.length) out.labels = p.labels;
          if (!out.description && p.description) out.description = p.description;
          return out;
        });

        const optimisticOnly = prev.filter((p) => !freshById.has(p.id));
        return [...merged, ...optimisticOnly];
      });
    }
  }, [initialTasks]);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [showSubtaskDialog, setShowSubtaskDialog] = useState(false);
  // When the page provides controlled sort/filter/search props we defer to it
  // so the api-worker query is keyed off those values. Otherwise fall back to
  // local state for back-compat with any other consumer.
  const isSortControlled = onSortChange !== undefined;
  const [internalSortState, setInternalSortState] = useState<SortState | null>(null);
  const sortState = isSortControlled ? (sortStateProp ?? null) : internalSortState;
  const setSortState = (next: SortState | null | ((prev: SortState | null) => SortState | null)) => {
    if (isSortControlled) {
      const resolved = typeof next === 'function' ? (next as (prev: SortState | null) => SortState | null)(sortState) : next;
      onSortChange!(resolved);
    } else {
      setInternalSortState(next);
    }
  };
  const [editingCrmTask, setEditingCrmTask] = useState<CrmTask | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // The task detail panel is now rendered globally via the object-panel host.
  // `selectedTask` is still kept as the page's "active row" pointer (some
  // table interactions reference it), but opening/closing the drawer is done
  // by pushing the task onto the object-panel stack via `useObjectPanel`.
  const { open: openTaskPanel } = useObjectPanel();
  useLayoutEffect(() => {
    if (selectedTask) openTaskPanel({ type: 'task', id: selectedTask.id });
  }, [selectedTask?.id, openTaskPanel]);

  const [isPending, startTransition] = useTransition();
  const [availableAssignees, setAvailableAssignees] = useState<{ id: string; name: string; avatar?: string }[]>([]);
  const [assigneeIdByName, setAssigneeIdByName] = useState<Record<string, string>>({});
  const [availableLabels, setAvailableLabels] = useState<ProjectLabel[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'pipeline'>('list');
  const [groupBy, setGroupBy] = useState<'status' | 'priority' | 'dueDate' | 'project' | 'none'>('status');

  // Drag-and-drop state for table view
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );
  const isDragEnabled = !sortState;
  const [comments, setComments] = useState<TaskComment[]>([]);
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

  // Fetch comments when a task is selected
  useEffect(() => {
    if (!selectedTask?.projectId) {
      setComments([]);
      return;
    }
    async function loadComments() {
      const result = await tasksApi.listComments(selectedTask!.projectId!, selectedTask!.id);
      if (result.success && result.data) {
        setComments(Array.isArray(result.data) ? result.data : []);
      }
    }
    loadComments();
  }, [selectedTask?.id, selectedTask?.projectId]);

  // Subtasks & dependencies state
  const [subtasks, setSubtasks] = useState<SubtaskItem[]>([]);
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<any>(null);

  useEffect(() => {
    if (!selectedTask?.projectId) {
      setSubtasks([]);
      setSelectedTaskDetail(null);
      return;
    }
    async function loadSubtasksAndDetail() {
      const [subtasksResult, detailResult] = await Promise.all([
        tasksApi.listSubtasks(selectedTask!.projectId!, selectedTask!.id),
        tasksApi.get(selectedTask!.projectId!, selectedTask!.id),
      ]);
      if (subtasksResult.success && subtasksResult.data) {
        setSubtasks(Array.isArray(subtasksResult.data) ? subtasksResult.data.map((s: any) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          assignee: s.assignee || null,
        })) : []);
      }
      if (detailResult.success && detailResult.data) {
        setSelectedTaskDetail(detailResult.data);
      }
    }
    loadSubtasksAndDetail();
  }, [selectedTask?.id, selectedTask?.projectId]);

  const dependencyTasks: DependencyTask[] = useMemo(() => {
    if (!selectedTaskDetail?.dependsOn?.length) return [];
    return (selectedTaskDetail.dependsOn as string[])
      .map((depId: string) => {
        const t = tasks.find(t => t.id === depId);
        return t ? { id: t.id, title: t.title, status: t.status } : null;
      })
      .filter(Boolean) as DependencyTask[];
  }, [selectedTaskDetail?.dependsOn, tasks]);

  const blockingTasks: DependencyTask[] = useMemo(() => {
    if (!selectedTaskDetail?.blocks?.length) return [];
    return (selectedTaskDetail.blocks as string[])
      .map((blockId: string) => {
        const t = tasks.find(t => t.id === blockId);
        return t ? { id: t.id, title: t.title, status: t.status } : null;
      })
      .filter(Boolean) as DependencyTask[];
  }, [selectedTaskDetail?.blocks, tasks]);

  const allProjectTasksForDeps: DependencyTask[] = useMemo(() =>
    tasks.filter(t => t.projectId === selectedTask?.projectId).map(t => ({ id: t.id, title: t.title, status: t.status })),
  [tasks, selectedTask?.projectId]);

  const parentTask = useMemo(() => {
    if (!selectedTaskDetail?.parentTaskId) return null;
    const parent = tasks.find(t => t.id === selectedTaskDetail.parentTaskId);
    return parent ? { id: parent.id, title: parent.title } : null;
  }, [selectedTaskDetail?.parentTaskId, tasks]);

  const handleCreateSubtask = useCallback(() => {
    setShowSubtaskDialog(true);
  }, []);

  const handleSaveSubtask = useCallback(async (data: {
    title: string;
    description?: string;
    status: any;
    priority?: 'low' | 'medium' | 'high';
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
        setSubtasks(prev => [...prev, {
          id: result.data.id,
          title: result.data.title,
          status: result.data.status,
          assignee: result.data.assignee || null,
        }]);
        setShowSubtaskDialog(false);
        toast.success(t.projects.myTasks.subtaskCreated);
        queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
      } else {
        toast.error(t.projects.myTasks.subtaskCreateFailed);
      }
    });
  }, [selectedTask, startTransition, queryClient]);

  const handleToggleSubtask = useCallback(async (subtaskId: string, currentStatus: string) => {
    if (!selectedTask?.projectId) return;
    const result = await tasksApi.toggle(selectedTask.projectId, subtaskId, currentStatus);
    if (result.success) {
      const newStatus = currentStatus === 'done' ? 'todo' : 'done';
      setSubtasks(prev => prev.map(s => s.id === subtaskId ? { ...s, status: newStatus } : s));
    }
  }, [selectedTask?.projectId]);

  const handleNavigateToTask = useCallback(async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      setSelectedTask(task);
      return;
    }
    // Task not in local list (subtask or dependency) — fetch from the selected task's project
    if (!selectedTask?.projectId) return;
    const result = await tasksApi.get(selectedTask.projectId, taskId);
    if (result.success && result.data) {
      const fetched = transformApiTask(result.data);
      setSelectedTask(fetched);
    }
  }, [tasks, selectedTask?.projectId]);

  const handleAddDependency = useCallback(async (targetTaskId: string, type: 'blocks' | 'blockedBy') => {
    if (!selectedTask?.projectId || !selectedTaskDetail) return;
    const currentDeps = selectedTaskDetail.dependsOn || [];
    const currentBlocks = selectedTaskDetail.blocks || [];

    const newData: { dependsOn?: string[]; blocks?: string[] } = {};
    if (type === 'blockedBy') {
      newData.dependsOn = [...new Set([...currentDeps, targetTaskId])];
      newData.blocks = currentBlocks;
    } else {
      newData.blocks = [...new Set([...currentBlocks, targetTaskId])];
      newData.dependsOn = currentDeps;
    }

    const result = await tasksApi.updateDependencies(selectedTask.projectId, selectedTask.id, newData);
    if (result.success && result.data) {
      setSelectedTaskDetail((prev: any) => prev ? { ...prev, dependsOn: result.data.dependsOn, blocks: result.data.blocks } : prev);
    } else {
      toast.error((result as any).error || t.projects.myTasks.failedToAddDependency);
    }
  }, [selectedTask, selectedTaskDetail]);

  const handleRemoveDependency = useCallback(async (targetTaskId: string, type: 'blocks' | 'blockedBy') => {
    if (!selectedTask?.projectId || !selectedTaskDetail) return;
    const currentDeps = selectedTaskDetail.dependsOn || [];
    const currentBlocks = selectedTaskDetail.blocks || [];

    const newData: { dependsOn?: string[]; blocks?: string[] } = {};
    if (type === 'blockedBy') {
      newData.dependsOn = currentDeps.filter((id: string) => id !== targetTaskId);
      newData.blocks = currentBlocks;
    } else {
      newData.blocks = currentBlocks.filter((id: string) => id !== targetTaskId);
      newData.dependsOn = currentDeps;
    }

    const result = await tasksApi.updateDependencies(selectedTask.projectId, selectedTask.id, newData);
    if (result.success && result.data) {
      setSelectedTaskDetail((prev: any) => prev ? { ...prev, dependsOn: result.data.dependsOn, blocks: result.data.blocks } : prev);
    }
  }, [selectedTask, selectedTaskDetail]);

  // Fetch workspace labels
  useEffect(() => {
    async function loadLabels() {
      const result = await labelsApi.list();
      if (result.success && result.data) {
        setAvailableLabels(result.data);
      }
    }
    loadLabels();
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
  }, []);

  // Fetch members from all projects for assignee dropdown
  useEffect(() => {
    async function loadMembers() {
      const results = await Promise.all(
        projects.map(p => membersApi.list(p.id))
      );
      const idMap: Record<string, string> = {};
      const memberMap = new Map<string, { id: string; name: string; avatar?: string }>();
      results.forEach(r => {
        (r.data || []).forEach((m: any) => {
          const name = m.user?.name;
          const id = m.userId || m.user?.id;
          const avatar = m.user?.avatar;
          if (name && id) {
            idMap[name] = id;
            if (!memberMap.has(id)) {
              memberMap.set(id, { id, name, avatar });
            }
          }
        });
      });
      setAvailableAssignees(Array.from(memberMap.values()));
      setAssigneeIdByName(idMap);
    }
    if (projects.length > 0) loadMembers();
  }, [projects]);

  // Real-time task event handlers
  const handleTaskCreated = useCallback((event: AnyPlatformEvent) => {
    const taskData = event.data as TaskEventData;
    const newTask: Task = {
      id: taskData.id,
      title: taskData.title,
      description: taskData.description,
      status: (taskData.status as Task['status']) || 'todo',
      priority: (taskData.priority as Task['priority']) || 'medium',
      assigneeId: taskData.assigneeId,
      assignee: taskData.assigneeName,
      dueDate: taskData.dueDate ? new Date(taskData.dueDate) : undefined,
      createdAt: taskData.createdAt ? new Date(taskData.createdAt) : new Date(),
      projectId: taskData.projectId,
      project: taskData.projectName,
      tags: taskData.tags,
      labels: (taskData as any).labels,
    };
    setTasks(prev => {
      if (prev.some(t => t.id === newTask.id)) return prev;
      return [newTask, ...prev];
    });
  }, []);

  const handleTaskUpdated = useCallback((event: AnyPlatformEvent) => {
    const taskData = event.data as TaskEventData;
    setTasks(prev => prev.map(task => {
      if (task.id !== taskData.id) return task;
      return {
        ...task,
        ...(taskData.title && { title: taskData.title }),
        ...(taskData.description !== undefined && { description: taskData.description }),
        ...(taskData.status && { status: taskData.status as Task['status'] }),
        ...(taskData.priority && { priority: taskData.priority as Task['priority'] }),
        ...(taskData.assigneeId !== undefined && { assigneeId: taskData.assigneeId }),
        ...(taskData.assigneeName !== undefined && { assignee: taskData.assigneeName }),
        ...(taskData.dueDate !== undefined && { dueDate: taskData.dueDate ? new Date(taskData.dueDate) : undefined }),
        ...(taskData.tags !== undefined && { tags: taskData.tags }),
      };
    }));
    setSelectedTask(prev => {
      if (!prev || prev.id !== taskData.id) return prev;
      return {
        ...prev,
        ...(taskData.title && { title: taskData.title }),
        ...(taskData.description !== undefined && { description: taskData.description }),
        ...(taskData.status && { status: taskData.status as Task['status'] }),
        ...(taskData.priority && { priority: taskData.priority as Task['priority'] }),
        ...(taskData.dueDate !== undefined && { dueDate: taskData.dueDate ? new Date(taskData.dueDate) : undefined }),
      };
    });
  }, []);

  const handleTaskDeleted = useCallback((event: AnyPlatformEvent) => {
    const taskData = event.data as TaskEventData;
    setTasks(prev => prev.filter(t => t.id !== taskData.id));
    setSelectedTask(prev => prev?.id === taskData.id ? null : prev);
  }, []);

  useTaskEvents({
    onCreated: handleTaskCreated,
    onUpdated: handleTaskUpdated,
    onDeleted: handleTaskDeleted,
  });

  const projectOptions = projects.map(p => ({ id: p.id, name: p.name }));
  const projectById = Object.fromEntries(projects.map(p => [p.id, p]));

  const handleSaveTask = (data: {
    title: string;
    description?: string;
    status: any;
    priority?: 'low' | 'medium' | 'high';
    assigneeId?: string;
    assigneeIds?: string[];
    dueDate?: Date;
    duration?: number;
    linkedCompanyId?: string;
    labels?: string[];
    repeat?: { frequency: string; interval?: number; unit?: string };
  }) => {
    const selectedProject = data.linkedCompanyId ? projectById[data.linkedCompanyId] : projects[0];

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
        // API response may not include all fields, fill from the form data the user just entered
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
        if (!newTask.dueDate && data.dueDate) newTask.dueDate = data.dueDate;
        if (!newTask.priority && data.priority) newTask.priority = data.priority;
        if ((!newTask.labels || newTask.labels.length === 0) && data.labels?.length) {
          newTask.labels = data.labels;
        }
        if (!newTask.description && data.description) newTask.description = data.description;
        if (newTask.duration == null && data.duration != null) newTask.duration = data.duration;
        setTasks(prev => [newTask, ...prev]);
        setShowTaskDialog(false);
        toast.success(t.projects.myTasks.taskCreated);
        queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
      } else {
        toast.error(result.error || t.projects.myTasks.taskCreateFailed);
      }
    });
  };

  const toggleTaskStatus = async (taskId: string) => {
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
        if ((result.data as any)?.nextTaskId) {
          const nextResult = await tasksApi.getById((result.data as any).nextTaskId);
          if (nextResult.success && nextResult.data) {
            setTasks(prev => [transformApiTask(nextResult.data), ...prev]);
            toast.success(t.projects.myTasks.nextRecurringCreated);
          }
        }

        queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
      } else {
        toast.error(result.error || t.projects.myTasks.taskUpdateFailed);
      }
    });
  };

  const deleteTask = async (taskId: string) => {
    startTransition(async () => {
      const result = await tasksApi.deleteById(taskId);
      if (result.success) {
        setTasks(tasks.filter((task) => task.id !== taskId));
        toast.success(t.projects.myTasks.taskDeleted);
        queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
      } else {
        toast.error(result.error || t.projects.myTasks.taskDeleteFailed);
      }
    });
  };

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
      if ((result.data as any)?.nextTaskId) {
        const nextResult = await tasksApi.getById((result.data as any).nextTaskId);
        if (nextResult.success && nextResult.data) {
          setTasks(prev => [transformApiTask(nextResult.data), ...prev]);
          toast.success(t.projects.myTasks.nextRecurringCreated);
        }
      }
      toast.success(t.projects.myTasks.taskMoved);
      queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
    } else {
      // Rollback
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: oldStatus } : t));
      toast.error(t.projects.myTasks.taskMoveFailed);
    }
  }, [tasks, t]);

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

  const statusOrder = ['backlog', 'todo', 'in_progress', 'in_review', 'testing', 'done', 'cancelled'];
  const priorityOrder = ['low', 'medium', 'high', 'urgent'];

  const sortedTasks = useMemo(() => {
    if (!sortState) return tasks;
    const { columnId, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;

    const tiebreak = (a: Task, b: Task) => {
      const aTime = a.createdAt?.getTime?.() ?? 0;
      const bTime = b.createdAt?.getTime?.() ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.id.localeCompare(b.id);
    };

    return [...tasks].sort((a, b) => {
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
  }, [tasks, sortState]);

  // Table drag-and-drop handler — commit reorder on drop
  const handleTableDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortedTasks.findIndex(t => t.id === active.id);
    const newIndex = sortedTasks.findIndex(t => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(sortedTasks, oldIndex, newIndex);
    setTasks(reordered);

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
        setTasks(arrayMove(reordered, newIndex, oldIndex));
        toast.error(t.projects.myTasks.reorderFailed);
        break;
      }
    }
  }, [sortedTasks, t]);

  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const updateTaskInline = useCallback(async (taskId: string, data: Record<string, any>) => {
    // Optimistic update
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...data } : t));
    setSelectedTask(prev => prev?.id === taskId ? { ...prev, ...data } : prev);

    const apiData: Record<string, any> = { ...data };
    if (data.dueDate !== undefined) {
      apiData.dueDate = data.dueDate ? data.dueDate.toISOString() : null;
    }
    if (data.assigneeIds !== undefined) {
      const ids = Array.isArray(data.assigneeIds) ? (data.assigneeIds as string[]) : [];
      apiData.assigneeIds = ids.length > 0 ? ids : null;
      delete apiData.assigneeId;
      delete apiData.assignee;
      delete apiData.assignees;
    } else if (data.assignees !== undefined) {
      const ids = (data.assignees as { id: string }[] | null | undefined)?.map((a) => a.id) ?? [];
      apiData.assigneeIds = ids.length > 0 ? ids : null;
      delete apiData.assigneeId;
      delete apiData.assignee;
      delete apiData.assignees;
    } else if (data.assigneeId !== undefined && data.assignee !== undefined) {
      apiData.assigneeId = data.assigneeId;
      delete apiData.assignee;
    }

    // Prefer the project-scoped task update endpoint (which already supports
    // multi-assignees) when the task has a projectId; fall back to the
    // global endpoint for truly orphan tasks.
    const existingTask = tasksRef.current.find((t) => t.id === taskId);
    const projectId = existingTask?.projectId;
    const result = projectId
      ? await tasksApi.update(projectId, taskId, apiData)
      : await tasksApi.updateById(taskId, apiData);
    if (result.success) {
      queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
    } else {
      // Rollback on failure
      setTasks(prev => prev.map(t => {
        if (t.id !== taskId) return t;
        const rollback = { ...t };
        Object.keys(data).forEach(k => delete (rollback as any)[k]);
        return rollback;
      }));
      toast.error(t.projects.myTasks.taskUpdateFailed);
    }
  }, [queryClient, t]);

  const formatDateShort = (date: Date) => {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: t.projects.myTasks.filterStatus,
      options: [
        { value: 'backlog', label: t.projects.myTasks.statusLabels.backlog },
        { value: 'todo', label: t.projects.myTasks.statusLabels.todo },
        { value: 'in_progress', label: t.projects.myTasks.statusLabels.inProgress },
        { value: 'in_review', label: t.projects.myTasks.statusLabels.inReview },
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
      options: projects.map(p => ({ value: p.name, label: p.name })),
    },
    {
      field: 'label',
      label: t.projects.myTasks.filterLabel,
      options: availableLabels.map(l => ({ value: l.id, label: l.name })),
    },
  ], [projects, availableLabels, t]);

  // Group configs vary by the active "Group by" choice.
  const groupConfigs: GroupConfig<Task>[] = useMemo(() => {
    if (groupBy === 'none') return [];

    if (groupBy === 'priority') {
      return [
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
      { id: 'in_review', label: t.projects.myTasks.statusLabels.inReview, sortOrder: 4, filter: (task) => task.status === 'in_review' },
      { id: 'testing', label: t.projects.myTasks.statusLabels.testing, sortOrder: 5, filter: (task) => task.status === 'testing' },
      { id: 'done', label: t.projects.myTasks.statusLabels.done, sortOrder: 6, filter: (task) => task.status === 'done' },
      { id: 'cancelled', label: t.projects.myTasks.statusLabels.cancelled, sortOrder: 7, filter: (task) => task.status === 'cancelled' },
    ];
  }, [groupBy, projects, t]);

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
          ? result.filter(t => t.project === filter.value)
          : result.filter(t => t.project !== filter.value);
      } else if (filter.field === 'label') {
        result = filter.operator === 'is'
          ? result.filter(t => Array.isArray((t as any).labels) && (t as any).labels.includes(filter.value))
          : result.filter(t => !Array.isArray((t as any).labels) || !(t as any).labels.includes(filter.value));
      }
    });
    return result;
  }, []);

  const handleSort = useCallback((columnId: string) => {
    setSortState(prev => {
      if (prev?.columnId === columnId) {
        if (prev.direction === 'asc') return { columnId, direction: 'desc' as const };
        return null;
      }
      return { columnId, direction: 'asc' as const };
    });
  }, []);

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

  // Render row content (reused for list rows and drag overlay)
  const renderTaskRow = useCallback((task: Task) => {
    const status = statusConfig[task.status] || statusConfig.todo;
    const priority = priorityConfig[task.priority] || priorityConfig.medium;

    return (
      <div
        key={task.id}
        onClick={() => setSelectedTask(task)}
        className={cn(
          "flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group",
          task.status === 'done' && "opacity-50"
        )}
      >
        {/* Checkbox */}
        <div className="w-4 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={task.status === 'done'}
            onCheckedChange={() => toggleTaskStatus(task.id)}
            disabled={isPending}
            className="h-4 w-4"
          />
        </div>

        {/* Task Title */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2">
          <span className={cn(
            "text-sm font-medium truncate min-w-0",
            task.status === 'done' ? "line-through text-gray-400" : "text-gray-900 dark:text-foreground"
          )}>
            {task.title}
          </span>
          {task.labels && task.labels.length > 0 && (
            <LabelOverflowList
              labels={task.labels
                .map((labelId) => availableLabels.find((l) => l.id === labelId))
                .filter((l): l is NonNullable<typeof l> => !!l)
                .map((l) => ({ id: l.id, name: l.name, color: l.color }))}
            />
          )}
          {task.tags && task.tags.length > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {task.tags.slice(0, 2).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">{tag}</Badge>
              ))}
              {task.tags.length > 2 && (
                <span className="text-[10px] text-gray-500">+{task.tags.length - 2}</span>
              )}
            </div>
          )}
          {task.repeat && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 flex-shrink-0">
              <Repeat className="h-2.5 w-2.5" />
              {task.repeat.frequency === 'custom' && task.repeat.interval && task.repeat.unit
                ? `${task.repeat.interval}${task.repeat.unit.charAt(0)}`
                : task.repeat.frequency === 'biweekly' ? '2w' : task.repeat.frequency.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        {/* Project */}
        <div className="w-[140px]">
          {task.project ? (
            <span className="text-sm text-gray-600 dark:text-muted-foreground truncate block">{task.project}</span>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        {/* Status */}
        <div className="w-[120px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn("px-2 py-0.5 rounded text-[12px] font-medium cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow", status.color, status.bg)}>
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
        <div className="w-[100px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn("px-2 py-0.5 rounded text-[12px] font-medium cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow", priority.color, priority.bg)}>
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
        <div className="w-[100px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="text-sm cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded px-1 py-0.5 transition-shadow">
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
                initialFocus
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
        <div className="w-[120px]" onClick={(e) => e.stopPropagation()}>
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
                name: fromDirectory?.name || fromAssignees?.name || (id === task.assigneeId ? task.assignee : '') || 'Unknown',
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
                      'cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded-[6px] pl-0.5 py-0.5 transition-shadow',
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
                        onClick={() => {
                          const nextIds = isSelected
                            ? resolvedIds.filter((id) => id !== member.id)
                            : [...resolvedIds, member.id];
                          const nextAssignees = nextIds.map((id) => {
                            const m = availableAssignees.find((x) => x.id === id);
                            return { id, name: m?.name || '', avatar: m?.avatar };
                          });
                          const primary = nextAssignees[0];
                          updateTaskInline(task.id, {
                            assigneeId: primary?.id ?? null,
                            assignee: primary?.name,
                            assigneeIds: nextIds,
                            assignees: nextAssignees,
                          });
                        }}
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
                        onClick={() => updateTaskInline(task.id, { assigneeId: null, assignee: undefined, assigneeIds: [], assignees: [] })}
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
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
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
                    title: `${task.title} (copy)`,
                    description: task.description,
                    status: task.status,
                    priority: task.priority,
                    repeat: task.repeat || undefined,
                  });
                  if (result.success && result.data) {
                    const newTask = transformApiTask(result.data);
                    if (!newTask.project && task.project) {
                      newTask.project = task.project;
                      newTask.projectId = task.projectId;
                    }
                    setTasks(prev => [newTask, ...prev]);
                    toast.success(t.projects.myTasks.taskDuplicated);
                    queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
                  } else {
                    toast.error(t.projects.myTasks.taskDuplicateFailed);
                  }
                });
              }}>
                <Copy className="h-3.5 w-3.5 mr-0.5" />
                {t.projects.myTasks.duplicate}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950" onClick={() => deleteTask(task.id)}>
                <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-600" />
                {t.projects.myTasks.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [isPending, toggleTaskStatus, deleteTask, availableLabels, handleStatusChange, updateTaskInline, availableAssignees, formatDateShort, startTransition, queryClient, t]);

  // Render row (wraps content with sortable when drag is enabled)
  const renderRow = useCallback((task: Task, handlers: RowHandlers<Task>) => {
    const rowContent = renderTaskRow(task);

    if (isDragEnabled) {
      return (
        <SortableTaskRow key={task.id} id={task.id} isDragEnabled={isDragEnabled}>
          {rowContent}
        </SortableTaskRow>
      );
    }

    return rowContent;
  }, [renderTaskRow, isDragEnabled]);

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
              items={sortedTasks}
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
            tasks={tasks}
            availableLabels={availableLabels}
            filterConfigs={filterConfigs}
            onTaskClick={(task) => setSelectedTask(task)}
            onStatusChange={handleStatusChange}
            onReorder={handlePipelineReorder}
            onCreateTask={(status) => {
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
          if (!open) setEditingCrmTask(null);
        }}
        editingTask={editingCrmTask}
        availableAssignees={availableAssignees}
        availableCompanies={projectOptions}
        availableLabels={availableLabels}
        onCreateLabel={handleCreateLabel}
        defaultAssignee={userId || undefined}
        defaultRecord={projects[0]?.id}
        recordLabel={t.projects.myTasks.selectProject}
        onSave={handleSaveTask}
        onUpdate={(taskId, data) => {
          const projectData: Record<string, any> = {};
          if (data.title) projectData.title = data.title;
          if (data.description !== undefined) projectData.description = data.description;
          if (data.status) projectData.status = statusFromCrm[data.status] || data.status;
          if (data.priority) projectData.priority = data.priority;
          if (data.dueDate !== undefined) projectData.dueDate = data.dueDate?.toISOString();
          if (data.labels !== undefined) projectData.labels = data.labels;
          if (data.repeat !== undefined) projectData.repeat = data.repeat || null;

          startTransition(async () => {
            const result = await tasksApi.updateById(taskId, projectData);
            if (result.success) {
              setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...projectData } : t));
              setSelectedTask(prev => prev?.id === taskId ? { ...prev, ...projectData } : prev);
              setShowTaskDialog(false);
              setEditingCrmTask(null);
              toast.success(t.projects.myTasks.taskUpdated);
              queryClient.invalidateQueries({ queryKey: taskKeys.myTasks() });
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
        onSave={handleSaveSubtask}
        onUpdate={() => {}}
        isPending={isPending}
      />

      {/* Task detail panel is now rendered globally via ObjectPanelHost. */}
    </>
  );
}
