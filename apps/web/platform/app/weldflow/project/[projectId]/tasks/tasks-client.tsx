
import React, { useState, useMemo, useTransition, useEffect, useLayoutEffect, useCallback, useRef, useContext } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { flushSync } from 'react-dom';
import { useOptionalBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useCompanies } from '@/components/objects/company/use-company-data';
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { Badge } from '@weldsuite/ui/components/badge';
import { type TaskComment, type SubtaskItem, type DependencyTask } from '@/components/task-detail';
import { useObjectPanel } from '@/components/object-panel';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
import { useAuth } from '@clerk/clerk-react';
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
  CalendarIcon,
  X,
  User,
  Repeat,
  ListTodo,
  Paperclip,
  Link,
  ChevronRight,
  FolderInput,
} from 'lucide-react';
import { Switch } from '@weldsuite/ui/components/switch';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { tasksApi, membersApi, labelsApi, stagesApi } from '@/app/weldflow/lib/api-client';
import { useFeatureFlag } from '@/hooks/queries/use-feature-flags-queries';
import { MoveTaskDialog } from '@/components/weldflow/move-task-dialog';
import { LabelOverflowList } from '@/app/weldflow/lib/label-overflow-list';
import type { Projects } from '@/lib/api/types/apps/projects.types';
import { useProjectPermissions, ProjectPermissionContext } from '@/app/weldflow/contexts/project-permission-context';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type RowHandlers, type SortState } from '@/components/entity-list';
import { TaskDialog } from '@/app/weldcrm/task-dialog';

interface Task {
  id: string;
  title: string;
  description?: string;
  stageId?: string | null;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee?: string;
  assigneeId?: string;
  assigneeIds?: string[];
  assignees?: { id: string; name: string; email?: string; avatar?: string }[];
  dueDate?: Date;
  createdAt: Date;
  tags?: string[];
  labels?: string[];
  customFields?: Record<string, any>;
  attachmentCount?: number;
  parentTaskId?: string | null;
  dependsOn?: string[];
  blocks?: string[];
  subtaskCount?: number;
  completedSubtaskCount?: number;
  key?: string;
  repeat?: { frequency: string; interval?: number; unit?: string } | null;
  customerId?: string | null;
  projectId?: string | null;
  scheduledStart?: string | Date | null;
  scheduledEnd?: string | Date | null;
  autoScheduled?: boolean | null;
  // Populated when the server nests descendants (includeSubtasks=true).
  // Not used directly by the render tree — `flattenTaskTree` pulls this out
  // into `inlineSubtasks` so the existing expand/toggle machinery works
  // without an extra fetch per parent.
  children?: Task[];
}

interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

// Project labels (created in project settings) store colors as Tailwind class names (e.g. "bg-blue-500"),
// while inline-created labels store hex values. Resolve to a CSS color so the badge always renders correctly.
const TAILWIND_LABEL_TO_HEX: Record<string, string> = {
  'bg-red-500': '#ef4444', 'bg-pink-500': '#ec4899', 'bg-purple-500': '#a855f7',
  'bg-indigo-500': '#6366f1', 'bg-blue-500': '#3b82f6', 'bg-cyan-500': '#06b6d4',
  'bg-teal-500': '#14b8a6', 'bg-green-500': '#22c55e', 'bg-yellow-500': '#eab308',
  'bg-orange-500': '#f97316', 'bg-amber-500': '#f59e0b', 'bg-gray-500': '#6b7280',
};
function resolveLabelColor(color: string | null | undefined): string {
  if (!color) return '#6b7280';
  if (color.startsWith('#')) return color;
  return TAILWIND_LABEL_TO_HEX[color] ?? '#6b7280';
}

interface ProjectMember {
  userId: string;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

interface TasksClientProps {
  projectId: string;
  initialTasks: Projects.ProjectTask[];
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  activeFilters?: ActiveFilter[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;
  sortState?: SortState | null;
  onSortChange?: (state: SortState | null) => void;
  /**
   * When set, the board renders in entity-scoped mode (CRM company/person panel).
   * Tasks come from the entity wrapper (useTasks with customerId/personId) and
   * span multiple projects. Project-only features (DnD reorder, sprints/sections
   * group-by, project stages, project members, breadcrumbs) are suppressed.
   */
  entityScope?: { kind: 'company' | 'person'; id: string };
}

// priorityConfig and statusConfig are built inside TasksClient (need t for labels)

// Transform API task to local Task format
function transformApiTask(apiTask: Projects.ProjectTask): Task {
  const rawChildren = (apiTask as any).children;
  return {
    id: apiTask.id,
    title: apiTask.title,
    description: apiTask.description || undefined,
    stageId: (apiTask as any).stageId ?? null,
    status: (apiTask.status as Task['status']) || 'todo',
    priority: (apiTask.priority as Task['priority']) || 'medium',
    assignee: apiTask.assignee?.name || undefined,
    assigneeId: apiTask.assigneeId || undefined,
    assigneeIds: apiTask.assigneeIds || (apiTask.assigneeId ? [apiTask.assigneeId] : undefined),
    assignees: (apiTask as any).assignees || (apiTask.assignee ? [apiTask.assignee] : undefined),
    dueDate: apiTask.dueDate ? new Date(apiTask.dueDate) : undefined,
    createdAt: new Date(apiTask.createdAt),
    tags: apiTask.tags || undefined,
    labels: apiTask.labels || undefined,
    customFields: (apiTask as any).customFields || undefined,
    attachmentCount: (apiTask as any).attachmentsCount || (apiTask as any)._count?.attachments || (Array.isArray((apiTask as any).customFields?.attachments) ? (apiTask as any).customFields.attachments.length : 0),
    parentTaskId: (apiTask as any).parentTaskId || null,
    customerId: (apiTask as any).customerId ?? null,
    projectId: (apiTask as any).projectId ?? null,
    dependsOn: (apiTask as any).dependsOn || [],
    blocks: (apiTask as any).blocks || [],
    subtaskCount: (apiTask as any).subtaskCount || 0,
    completedSubtaskCount: (apiTask as any).completedSubtaskCount || 0,
    key: (apiTask as any).key || undefined,
    repeat: (apiTask as any).repeat || undefined,
    children: Array.isArray(rawChildren) ? rawChildren.map(transformApiTask) : undefined,
  };
}

// Split a nested task tree (as returned by /tasks?includeSubtasks=true) into
// the shape the render layer expects: flat top-level list + per-parent
// inline subtasks map + the set of parent IDs that should render expanded.
// Called once whenever the server payload changes — replaces the N+1
// auto-fetch effect that used to hit /subtasks per parent. Computing
// `expandedIds` here (not via useEffect) avoids the flash where every
// parent starts collapsed for one render.
function flattenTaskTree(roots: Task[]): {
  topLevel: Task[];
  inlineSubtasks: Record<string, Task[]>;
  expandedIds: Set<string>;
} {
  const inline: Record<string, Task[]> = {};
  const expanded = new Set<string>();
  const walk = (node: Task) => {
    const kids = node.children;
    if (kids && kids.length > 0) {
      expanded.add(node.id);
      inline[node.id] = kids.map((k) => ({ ...k, children: undefined }));
      for (const k of kids) walk(k);
    }
  };
  const topLevel = roots.map((r) => {
    walk(r);
    return { ...r, children: undefined };
  });
  return { topLevel, inlineSubtasks: inline, expandedIds: expanded };
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

function toCrmTask(
  task: Task,
  projectMembers: ProjectMember[],
  availableCompanies: { id: string; name: string; avatar?: string }[] = [],
): CrmTask & { assignees?: { id: string; name: string; avatar?: string }[]; customFields?: Record<string, any>; linkedCompany?: { id: string; name: string; avatar?: string } } {
  // Build assignees list from task.assignees or resolve from ids — preserves
  // the avatar URL so the panel can render real profile pictures.
  let assigneesList: { id: string; name: string; avatar?: string }[] = [];
  if (task.assignees && task.assignees.length > 0) {
    assigneesList = task.assignees.map(a => {
      const member = projectMembers.find(m => m.userId === a.id);
      return { id: a.id, name: a.name, avatar: a.avatar || member?.user?.avatar };
    });
  } else if (task.assigneeIds && task.assigneeIds.length > 0) {
    assigneesList = task.assigneeIds
      .map(id => {
        const member = projectMembers.find(m => m.userId === id);
        return member?.user
          ? { id: member.userId, name: member.user.name, avatar: member.user.avatar }
          : null;
      })
      .filter(Boolean) as { id: string; name: string; avatar?: string }[];
  } else if (task.assigneeId) {
    const member = projectMembers.find(m => m.userId === task.assigneeId);
    const name = task.assignee || member?.user?.name;
    if (name) {
      assigneesList = [{ id: task.assigneeId, name, avatar: member?.user?.avatar }];
    }
  }

  const primaryAssignee = assigneesList[0] || undefined;
  const linkedCompany = task.customerId
    ? availableCompanies.find((c) => c.id === task.customerId)
    : undefined;
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: statusToCrm[task.status] || 'todo',
    priority: task.priority === 'urgent' ? 'high' : (task.priority as CrmTask['priority']),
    assignee: primaryAssignee,
    assignees: assigneesList,
    dueDate: task.dueDate,
    createdAt: task.createdAt,
    labels: task.labels,
    customFields: task.customFields,
    repeat: task.repeat || undefined,
    linkedCompany: linkedCompany || undefined,
    scheduledStart: task.scheduledStart ? new Date(task.scheduledStart) : null,
    scheduledEnd: task.scheduledEnd ? new Date(task.scheduledEnd) : null,
    autoScheduled: task.autoScheduled ?? null,
  } as CrmTask & { assignees?: { id: string; name: string }[]; customFields?: Record<string, any>; repeat?: { frequency: string; interval?: number; unit?: string }; linkedCompany?: { id: string; name: string; avatar?: string } };
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

export function TasksClient({
  projectId,
  initialTasks,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  searchQuery: searchQueryProp,
  onSearchChange,
  activeFilters: activeFiltersProp,
  onFiltersChange,
  sortState: sortStateProp,
  onSortChange,
  entityScope,
}: TasksClientProps) {
  const { t } = useI18n();
  // Entity mode: board is embedded inside a CRM panel scoped to a company/person.
  // Tasks span multiple projects; project-only features are suppressed.
  const isEntityMode = !!entityScope;

  const priorityConfig = {
    low: { label: t.projects.tasks.priorityLow, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    medium: { label: t.projects.tasks.priorityMedium, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    high: { label: t.projects.tasks.priorityHigh, color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
    urgent: { label: t.projects.tasks.priorityUrgent, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
    critical: { label: t.projects.tasks.priorityCritical, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  };

  const statusConfig: Record<string, { label: string; icon: typeof Circle; color: string; bg: string }> = {
    backlog: { label: t.projects.tasks.statusBacklog, icon: Circle, color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-900/50' },
    todo: { label: t.projects.tasks.statusTodo, icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    in_progress: { label: t.projects.tasks.statusInProgress, icon: Clock, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    review: { label: t.projects.tasks.statusReview, icon: Clock, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
    in_review: { label: t.projects.tasks.statusInReview, icon: Clock, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
    testing: { label: t.projects.tasks.statusTesting, icon: Clock, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
    done: { label: t.projects.tasks.statusDone, icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
    cancelled: { label: t.projects.tasks.statusCancelled, icon: Circle, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  };

  // In entity mode the component is embedded in a CRM object panel, which has
  // no BreadcrumbProvider — useOptionalBreadcrumbs no-ops there instead of
  // throwing.
  useOptionalBreadcrumbs(
    isEntityMode
      ? []
      : [
          { label: t.projects.tasks.projects, href: '/weldflow' },
          { label: t.projects.tasks.title },
        ],
  );

  const initialFlattened = useMemo(() => flattenTaskTree(initialTasks.map(transformApiTask)), [initialTasks]);
  const [tasks, setTasks] = useState<Task[]>(initialFlattened.topLevel);
  const [inlineSubtasks, setInlineSubtasks] = useState<Record<string, Task[]>>(initialFlattened.inlineSubtasks);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(initialFlattened.expandedIds);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showSubtaskDialog, setShowSubtaskDialog] = useState(false);
  // WeldFlow "Move to project" — gated behind the weldflow-move-task flag.
  const showMoveTask = useFeatureFlag('weldflow-move-task');
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
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
  const [groupBy, setGroupBy] = useState<'status' | 'priority' | 'dueDate' | 'assignee' | 'none'>('status');
  const [completingTaskIds, setCompletingTaskIds] = useState<Set<string>>(new Set());

  // Sync local state when initialTasks change (e.g., switching projects).
  // Re-seeds the flat top-level list, the per-parent subtask map, and the
  // expanded-parents set — the server already nested the full descendant
  // tree for us, so nothing here fires a network request.
  useEffect(() => {
    setTasks(initialFlattened.topLevel);
    setInlineSubtasks(initialFlattened.inlineSubtasks);
    setExpandedTaskIds((prev) => {
      // Union with any IDs the user has since expanded manually so we don't
      // clobber their state if initialTasks re-renders for an unrelated reason.
      const next = new Set(prev);
      for (const id of initialFlattened.expandedIds) next.add(id);
      return next;
    });
  }, [initialFlattened]);

  const [editingCrmTask, setEditingCrmTask] = useState<CrmTask | null>(null);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  // Fetch companies so the task detail panel's Company picker has real
  // options to choose from (instead of "No records available").
  const companiesQuery = useCompanies({ limit: 100 });
  const availableCompanies = useMemo(() => {
    const items = companiesQuery.data?.data ?? [];
    return items
      .map((c) => ({
        id: c.id,
        name: c.name || c.displayName,
        avatar: c.avatarUrl ?? undefined,
      }))
      .filter((c) => c.name);
  }, [companiesQuery.data]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // The detail panel is rendered globally via ObjectPanelHost — opening it
  // just pushes the task id onto the object-panel stack.
  const { open: openTaskPanel } = useObjectPanel();
  useLayoutEffect(() => {
    if (selectedTask) openTaskPanel({ type: 'task', id: selectedTask.id });
  }, [selectedTask?.id, openTaskPanel]);

  const [isPending, startTransition] = useTransition();
  // Read the permission context directly (not via useProjectPermissions which throws
  // when no ProjectPermissionProvider is in the tree). In entity mode there is no
  // provider, so the context returns the default value (all-false). We override that
  // to a permissive set so the CRM panel doesn't hide write controls.
  const rawPermCtx = useContext(ProjectPermissionContext);
  const { canWrite } = isEntityMode ? { canWrite: true } : rawPermCtx;
  const [availableLabels, setAvailableLabels] = useState<ProjectLabel[]>([]);
  const [projectStages, setProjectStages] = useState<Array<{ id: string; name: string; color: string; systemStatus: string }>>([]);
  // Parents the user checked while at least one subtask was still open. They
  // render as completed (strikethrough, checkbox on) but stay in their current
  // status group until every subtask is done — at which point we persist the
  // real `done` status and drop them from this set.
  const [pendingParentCompletionIds, setPendingParentCompletionIds] = useState<Set<string>>(new Set());

  // Drag-and-drop state
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );
  // Drag reorder is disabled in entity mode (tasks span multiple projects — there
  // is no single position sequence to persist) and whenever a sort is active.
  const isDragEnabled = !isEntityMode && canWrite && !sortState;
  const [comments, setComments] = useState<TaskComment[]>([]);
  const { userId } = useAuth();

  // Fetch comments when a task is selected
  useEffect(() => {
    if (!selectedTask) {
      setComments([]);
      return;
    }
    async function loadComments() {
      const result = await tasksApi.listComments(projectId, selectedTask!.id);
      if (result.success && result.data) {
        setComments(Array.isArray(result.data) ? result.data : []);
      }
    }
    loadComments();
  }, [selectedTask?.id, projectId]);

  // Subtasks & dependencies state
  const [subtasks, setSubtasks] = useState<SubtaskItem[]>([]);
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<any>(null);
  // Tracks which parent the current `subtasks` list belongs to so sibling-to-
  // sibling navigation doesn't re-fetch, and cross-parent navigation replaces
  // the list instead of accumulating.
  const subtasksParentIdRef = useRef<string | null>(null);

  // Fetch subtasks and task detail when a task is selected. The Subtasks
  // section lists the selected task's ENTIRE subtree — direct children plus
  // every descendant — flattened with `depth` on each row so the panel can
  // indent them. We BFS level-by-level (parallel within a level) and re-apply
  // the flattened tree after each level, so shallow descendants show
  // immediately and deeper levels fill in progressively.
  useEffect(() => {
    if (!selectedTask) {
      setSubtasks([]);
      setSelectedTaskDetail(null);
      subtasksParentIdRef.current = null;
      return;
    }
    let cancelled = false;

    const listSubtasksOf = selectedTask.id;
    const parentChanged = subtasksParentIdRef.current !== listSubtasksOf;
    subtasksParentIdRef.current = listSubtasksOf;
    if (parentChanged) {
      // Different task: clear the previous subtree so stale rows don't linger
      // while we re-fetch.
      setSubtasks([]);
    }

    const flattenTree = (
      rootId: string,
      childrenByParent: Map<string, any[]>,
      depth: number,
    ): SubtaskItem[] => {
      const out: SubtaskItem[] = [];
      const children = childrenByParent.get(rootId) || [];
      for (const c of children) {
        out.push({
          id: c.id,
          title: c.title,
          status: c.status,
          assignee: c.assignee || null,
          depth,
        });
        out.push(...flattenTree(c.id, childrenByParent, depth + 1));
      }
      return out;
    };

    const applyFlat = (flat: SubtaskItem[]) => {
      if (cancelled) return;
      const serverIds = new Set(flat.map((s) => s.id));
      // Preserve optimistic pending rows (created client-side but not yet
      // reflected by the server) at the bottom — they'll reconcile on the
      // next fetch cycle.
      setSubtasks((prev) => {
        const pending = prev.filter((p) => !serverIds.has(p.id));
        return [...flat, ...pending];
      });
    };

    const detailPromise = tasksApi.get(projectId, selectedTask.id).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setSelectedTaskDetail(res.data);
      }
    });

    // The list endpoint already returned this task's full descendant subtree
    // nested under `children` (flattened into `inlineSubtasks`). If the
    // selected task is reachable from that tree we can render the detail
    // panel's subtasks section from memory — zero network requests.
    const knownFromCache =
      tasks.some((t) => t.id === listSubtasksOf) ||
      Object.values(inlineSubtasks).some((list) => list.some((s) => s.id === listSubtasksOf));

    if (knownFromCache) {
      const childrenByParent = new Map<string, any[]>();
      for (const [pid, list] of Object.entries(inlineSubtasks)) {
        childrenByParent.set(pid, list);
      }
      applyFlat(flattenTree(listSubtasksOf, childrenByParent, 0));
    } else {
      // Fallback: task was opened via deep-link / search and isn't on the
      // current page, so walk the API level by level.
      const listPromise = (async () => {
        const childrenByParent = new Map<string, any[]>();
        let frontier: string[] = [listSubtasksOf];
        while (frontier.length > 0) {
          const results = await Promise.all(
            frontier.map((id) =>
              tasksApi.listSubtasks(projectId, id).then((r) => ({ id, r })),
            ),
          );
          if (cancelled) return;
          const nextFrontier: string[] = [];
          for (const { id, r } of results) {
            const list = r.success && Array.isArray(r.data) ? r.data : [];
            childrenByParent.set(id, list);
            for (const child of list) {
              if ((child.subtaskCount ?? 0) > 0) nextFrontier.push(child.id);
            }
          }
          applyFlat(flattenTree(listSubtasksOf, childrenByParent, 0));
          frontier = nextFrontier;
        }
      })();
      void listPromise;
    }

    void detailPromise;
    return () => { cancelled = true; };
  }, [selectedTask?.id, projectId, tasks, inlineSubtasks]);

  // Resolve dependency/blocking tasks from detail data
  const dependencyTasks: DependencyTask[] = useMemo(() => {
    if (!selectedTaskDetail?.dependsOn?.length) return [];
    return (selectedTaskDetail.dependsOn as string[])
      .map((depId: string) => {
        const t = tasks.find(t => t.id === depId);
        return t ? { id: t.id, title: t.title, status: t.status, key: t.key } : null;
      })
      .filter(Boolean) as DependencyTask[];
  }, [selectedTaskDetail?.dependsOn, tasks]);

  const blockingTasks: DependencyTask[] = useMemo(() => {
    if (!selectedTaskDetail?.blocks?.length) return [];
    return (selectedTaskDetail.blocks as string[])
      .map((blockId: string) => {
        const t = tasks.find(t => t.id === blockId);
        return t ? { id: t.id, title: t.title, status: t.status, key: t.key } : null;
      })
      .filter(Boolean) as DependencyTask[];
  }, [selectedTaskDetail?.blocks, tasks]);

  const allProjectTasks: DependencyTask[] = useMemo(() =>
    tasks.map(t => ({ id: t.id, title: t.title, status: t.status, key: t.key })),
  [tasks]);

  const parentTask = useMemo(() => {
    const parentId =
      selectedTaskDetail?.parentTaskId || (selectedTask as any)?.parentTaskId || null;
    if (!parentId) return null;
    // 1. Try the main tasks array (top-level parents live here).
    const fromTasks = tasks.find(t => t.id === parentId);
    if (fromTasks) {
      return { id: fromTasks.id, title: fromTasks.title, status: fromTasks.status };
    }
    // 2. Look in `inlineSubtasks` (parent may itself be a subtask of another
    //    task we've expanded inline).
    for (const parentList of Object.values(inlineSubtasks)) {
      const match = parentList.find((s) => s.id === parentId);
      if (match) {
        return { id: match.id, title: match.title, status: match.status };
      }
    }
    // 3. Finally, peek at the detail response — some endpoints nest a
    //    `parent` object.
    const nested = selectedTaskDetail?.parent;
    if (nested?.id && nested?.title) {
      return { id: nested.id, title: nested.title, status: nested.status };
    }
    return null;
  }, [
    selectedTaskDetail?.parentTaskId,
    (selectedTask as any)?.parentTaskId,
    selectedTaskDetail?.parent,
    tasks,
    inlineSubtasks,
  ]);

  const handleCreateSubtask = useCallback(() => {
    setShowSubtaskDialog(true);
  }, []);

  const handleSaveSubtask = useCallback(async (data: {
    title: string;
    description?: string;
    status: any;
    priority?: 'low' | 'medium' | 'high';
    assigneeId?: string;
    assigneeIds?: string[];
    dueDate?: Date;
    labels?: string[];
  }) => {
    if (!selectedTask) return;
    setIsCreatingTask(true);
    // New subtasks are always children of the currently-selected task, so
    // nesting can go arbitrarily deep (subtasks of subtasks of…).
    // In entity mode the task already carries its own projectId from the API.
    const parentId = selectedTask.id;
    const effectiveProjectId = (isEntityMode ? (selectedTask as any).projectId : null) ?? projectId;
    const result = await tasksApi.create(effectiveProjectId, {
      title: data.title,
      description: data.description,
      status: data.status || 'todo',
      priority: data.priority,
      assigneeIds: data.assigneeIds || (data.assigneeId ? [data.assigneeId] : undefined),
      dueDate: data.dueDate?.toISOString(),
      labels: data.labels,
      parentTaskId: parentId,
    });
    setIsCreatingTask(false);
    if (result.success && result.data) {
      const newSubtask = transformApiTask(result.data);
      setSubtasks(prev => [...prev, {
        id: result.data.id,
        title: result.data.title,
        status: result.data.status,
        assignee: result.data.assignee || null,
        // New row is a direct child of the currently-selected task, which is
        // the implicit root of the detail panel's subtask tree — depth 0.
        depth: 0,
      }]);
      // Seed / append to the list-view inline cache so the tree picks up the
      // new child immediately, regardless of depth.
      setInlineSubtasks(prev => ({
        ...prev,
        [parentId]: prev[parentId] ? [...prev[parentId], newSubtask] : [newSubtask],
      }));
      // Auto-expand the parent so the new child is visible.
      setExpandedTaskIds(prev => {
        if (prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.add(parentId);
        return next;
      });
      // Bump the parent's subtaskCount — it may live in the top-level `tasks`
      // array OR inside an `inlineSubtasks` list (if the parent is itself a
      // subtask). Patch both so any render path sees the new count.
      setTasks(prev => prev.map(t => t.id === parentId
        ? { ...t, subtaskCount: (t.subtaskCount ?? 0) + 1 }
        : t
      ));
      setInlineSubtasks(prev => {
        let touched = false;
        const next: Record<string, Task[]> = {};
        for (const [pid, subs] of Object.entries(prev)) {
          let list = subs;
          const idx = subs.findIndex((s) => s.id === parentId);
          if (idx !== -1) {
            list = [...subs];
            list[idx] = { ...list[idx], subtaskCount: (list[idx].subtaskCount ?? 0) + 1 };
            touched = true;
          }
          next[pid] = list;
        }
        return touched ? next : prev;
      });
      setShowSubtaskDialog(false);
      toast.success(t.projects.tasks.subtaskCreated);
    } else {
      toast.error(t.projects.tasks.failedToCreateSubtask);
    }
  }, [isEntityMode, selectedTask, projectId]);

  const handleToggleSubtask = useCallback(async (subtaskId: string, currentStatus: string) => {
    const result = await tasksApi.toggle(projectId, subtaskId, currentStatus);
    if (result.success) {
      const newStatus = currentStatus === 'done' ? 'todo' : 'done';
      setSubtasks(prev => prev.map(s => s.id === subtaskId ? { ...s, status: newStatus } : s));
      // Update inline subtasks cache
      setInlineSubtasks(prev => {
        const updated: Record<string, Task[]> = {};
        for (const [parentId, subs] of Object.entries(prev)) {
          updated[parentId] = subs.map(s => s.id === subtaskId ? { ...s, status: newStatus as Task['status'] } : s);
        }
        return updated;
      });
    }
  }, [projectId]);

  const handleNavigateToTask = useCallback(async (taskId: string) => {
    // 1. Top-level tasks live in `tasks` — instant.
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      setSelectedTask(task);
      return;
    }
    // 2. Subtasks we've already fetched live in `inlineSubtasks` as full Task
    //    objects (including parentTaskId) — instant, no network round-trip.
    for (const parentList of Object.values(inlineSubtasks)) {
      const match = parentList.find(t => t.id === taskId);
      if (match) {
        setSelectedTask(match);
        return;
      }
    }
    // 3. Fallback: fetch from the server.
    const result = await tasksApi.get(projectId, taskId);
    if (result.success && result.data) {
      const fetched = transformApiTask(result.data);
      setSelectedTask(fetched);
    }
  }, [tasks, projectId, inlineSubtasks]);

  // Mirror inlineSubtasks into a ref so toggleExpandTask can read the latest
  // cache without listing it as a dependency — that kept the callback stable
  // and stopped clicks from recreating the whole row render chain.
  const inlineSubtasksRef = useRef(inlineSubtasks);
  useEffect(() => {
    inlineSubtasksRef.current = inlineSubtasks;
  }, [inlineSubtasks]);

  const toggleExpandTask = useCallback((taskId: string) => {
    // Flip the expanded set synchronously — one setState, no awaits, no
    // dependency on expandedTaskIds so this callback identity never changes.
    setExpandedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
    // Since the list endpoint returned the full descendant tree, the cache is
    // essentially always warm. This fire-and-forget fetch is a safety net for
    // edge cases (e.g. a task created while offline then re-synced) — the row
    // expands instantly and populates when the fetch resolves.
    if (!inlineSubtasksRef.current[taskId]) {
      tasksApi.listSubtasks(projectId, taskId).then((result) => {
        if (result.success && result.data && Array.isArray(result.data)) {
          setInlineSubtasks((prev) =>
            prev[taskId]
              ? prev
              : { ...prev, [taskId]: (result.data as any[]).map(transformApiTask) },
          );
        }
      });
    }
  }, [projectId]);

  const handleAddDependency = useCallback(async (targetTaskId: string, type: 'blocks' | 'blockedBy') => {
    if (!selectedTask || !selectedTaskDetail) return;
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

    const result = await tasksApi.updateDependencies(projectId, selectedTask.id, newData);
    if (result.success && result.data) {
      setSelectedTaskDetail((prev: any) => prev ? { ...prev, dependsOn: result.data.dependsOn, blocks: result.data.blocks } : prev);
    } else {
      toast.error((result as any).error || t.projects.tasks.failedToAddDependency);
    }
  }, [selectedTask, selectedTaskDetail, projectId]);

  const handleRemoveDependency = useCallback(async (targetTaskId: string, type: 'blocks' | 'blockedBy') => {
    if (!selectedTask || !selectedTaskDetail) return;
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

    const result = await tasksApi.updateDependencies(projectId, selectedTask.id, newData);
    if (result.success && result.data) {
      setSelectedTaskDetail((prev: any) => prev ? { ...prev, dependsOn: result.data.dependsOn, blocks: result.data.blocks } : prev);
    }
  }, [selectedTask, selectedTaskDetail, projectId]);

  // Fetch labels. In entity mode we fetch workspace-wide labels only (no projectId)
  // because tasks span multiple projects. In project mode we fetch project + workspace labels.
  useEffect(() => {
    async function loadLabels() {
      const result = isEntityMode ? await labelsApi.list() : await labelsApi.list(projectId);
      if (result.success && result.data) {
        setAvailableLabels(result.data);
      }
    }
    loadLabels();
  }, [projectId, isEntityMode]);

  // Fetch this project's pipeline stages for the Create Task dialog.
  // In entity mode stages are per-project and meaningless cross-project; skip the
  // fetch and leave projectStages empty so the board falls back to status-based grouping.
  useEffect(() => {
    if (isEntityMode) return;
    async function loadStages() {
      const result = await stagesApi.list(projectId);
      if (result.success && Array.isArray(result.data)) {
        const sorted = [...result.data].sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
        setProjectStages(sorted.map((s: any) => ({
          id: s.id,
          name: s.name,
          color: s.color || '#94a3b8',
          systemStatus: s.systemStatus || s.id,
        })));
      }
    }
    loadStages();
  }, [projectId, isEntityMode]);

  const handleCreateLabel = useCallback(async (data: { name: string; color: string }): Promise<ProjectLabel | null> => {
    // In entity mode there is no single project — create a workspace-wide label (no projectId).
    const result = await labelsApi.create({ ...data, ...(isEntityMode ? {} : { projectId }) });
    if (result.success && result.data) {
      const newLabel: ProjectLabel = { id: result.data.id, name: data.name, color: data.color };
      setAvailableLabels(prev => [newLabel, ...prev]);
      return newLabel;
    }
    toast.error(t.projects.tasks.failedToCreateLabel);
    return null;
  }, [isEntityMode, projectId]);

  // Real-time task event handlers - update local state directly without page refresh
  const handleTaskCreated = useCallback((event: AnyPlatformEvent) => {
    const taskData = event.data as TaskEventData;

    // In project mode: filter to this project only.
    // In entity mode: accept any project's tasks (entity filter is by customerId/personId
    // which isn't available in the event payload — a full refetch on the tab becoming
    // visible is the safety net for entity mode).
    if (!isEntityMode && taskData.projectId !== projectId) return;

    // Look up assignee name from project members if we have an assigneeId
    let assigneeName = taskData.assigneeName;
    if (!assigneeName && taskData.assigneeId) {
      const member = projectMembers.find(m => m.userId === taskData.assigneeId);
      assigneeName = member?.user?.name;
    }

    // Convert event data to local Task format
    const newTask: Task = {
      id: taskData.id,
      title: taskData.title,
      description: taskData.description,
      status: (taskData.status as Task['status']) || 'todo',
      priority: (taskData.priority as Task['priority']) || 'medium',
      assigneeId: taskData.assigneeId,
      assignee: assigneeName,
      dueDate: taskData.dueDate ? new Date(taskData.dueDate) : undefined,
      createdAt: taskData.createdAt ? new Date(taskData.createdAt) : new Date(),
      tags: taskData.tags,
    };

    // Add task only if it doesn't already exist (prevents duplicates when same user has multiple tabs)
    setTasks(prev => {
      if (prev.some(t => t.id === newTask.id)) {
        return prev;
      }
      return [newTask, ...prev];
    });
  }, [isEntityMode, projectId, projectMembers]);

  const handleTaskUpdated = useCallback((event: AnyPlatformEvent) => {
    const taskData = event.data as TaskEventData;

    setTasks(prev => prev.map(task => {
      if (task.id !== taskData.id) return task;

      // Merge updates into existing task
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
  }, []);

  const handleTaskDeleted = useCallback((event: AnyPlatformEvent) => {
    const taskData = event.data as TaskEventData;
    setTasks(prev => prev.filter(task => task.id !== taskData.id));
  }, []);

  // Subscribe to real-time task events
  useTaskEvents({
    onCreated: handleTaskCreated,
    onUpdated: handleTaskUpdated,
    onDeleted: handleTaskDeleted,
  });

  // Fetch project members for assignee dropdown.
  // In entity mode there is no single project to query for members. Instead we
  // derive a synthetic member list from the assignees embedded in the task data,
  // so the assignee column + popover still renders correctly.
  useEffect(() => {
    if (isEntityMode) return;
    async function loadMembers() {
      const result = await membersApi.list(projectId);
      if (result.success && result.data) {
        setProjectMembers(result.data);
      }
    }
    loadMembers();
  }, [projectId, isEntityMode]);

  // In entity mode: build a synthetic ProjectMember list from assignees already
  // embedded in the task data. This populates the assignee column without a
  // per-project API call.
  useEffect(() => {
    if (!isEntityMode) return;
    const seen = new Map<string, ProjectMember>();
    for (const task of tasks) {
      const assigneesList = task.assignees ?? [];
      for (const a of assigneesList) {
        if (!seen.has(a.id)) {
          seen.set(a.id, {
            userId: a.id,
            user: { id: a.id, name: a.name, email: a.email ?? '', avatar: a.avatar },
          });
        }
      }
      // Also handle legacy single-assignee fields
      if (!seen.has(task.assigneeId ?? '') && task.assigneeId && task.assignee) {
        seen.set(task.assigneeId, {
          userId: task.assigneeId,
          user: { id: task.assigneeId, name: task.assignee, email: '' },
        });
      }
    }
    setProjectMembers(Array.from(seen.values()));
  }, [isEntityMode, tasks]);

  const handleTaskDialogSave = async (data: {
    title: string;
    description?: string;
    status: string;
    priority?: 'low' | 'medium' | 'high';
    assigneeId?: string;
    assigneeIds?: string[];
    dueDate?: Date;
    labels?: string[];
    repeat?: { frequency: string; interval?: number; unit?: string };
  }) => {
    // Map CRM status format to project format (now 1:1)
    const statusMap: Record<string, string> = {
      'backlog': 'backlog',
      'todo': 'todo',
      'in_progress': 'in_progress',
      'in_review': 'in_review',
      'testing': 'testing',
      'done': 'done',
      'cancelled': 'cancelled',
    };

    // If the user picked a project stage in the dialog, prefer its id+systemStatus.
    const pickedStage = projectStages.find(s => s.id === data.status);
    const resolvedStageId = pickedStage?.id;
    const resolvedStatus = pickedStage?.systemStatus ?? statusMap[data.status] ?? 'todo';

    setIsCreatingTask(true);
    const result = await tasksApi.create(projectId, {
      title: data.title,
      description: data.description,
      stageId: resolvedStageId,
      status: resolvedStatus,
      priority: data.priority,
      assigneeIds: data.assigneeIds || (data.assigneeId ? [data.assigneeId] : undefined),
      dueDate: data.dueDate?.toISOString(),
      labels: data.labels,
      repeat: data.repeat ? { frequency: data.repeat.frequency } : undefined,
    });
    setIsCreatingTask(false);

    if (result.success && result.data) {
      const newTask = transformApiTask(result.data);
      setTasks(prev => [newTask, ...prev]);
      setShowAddDialog(false);
      toast.success(t.projects.tasks.taskCreated);
    } else {
      toast.error(result.error || t.projects.tasks.failedToCreateTask);
    }
  };

  const toggleTaskStatus = useCallback(async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    startTransition(async () => {
      const result = await tasksApi.toggle(projectId, taskId, task.status);

      if (result.success) {
        setTasks(prev => prev.map((t) => {
          if (t.id === taskId) {
            const newStatus = t.status === 'done' ? 'todo' : 'done';
            return { ...t, status: newStatus };
          }
          return t;
        }));

        // If a next recurring task was created, fetch and add it
        if ((result.data as any)?.nextTaskId) {
          const nextResult = await tasksApi.get(projectId, (result.data as any).nextTaskId);
          if (nextResult.success && nextResult.data) {
            setTasks(prev => [transformApiTask(nextResult.data), ...prev]);
            toast.success(t.projects.tasks.nextRecurringCreated);
          }
        }
      } else {
        toast.error(result.error || t.projects.tasks.failedToUpdateTask);
      }
    });
  }, [tasks, projectId, startTransition]);

  const handleCheckboxToggle = useCallback(async (taskId: string, currentStatus: Task['status']) => {
    if (!canWrite) return;

    // Unchecking a pending-complete parent — just drop it from the set,
    // don't touch the server (status was never changed).
    if (pendingParentCompletionIds.has(taskId)) {
      setPendingParentCompletionIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      return;
    }

    // Look for the task in the main list first, then in any expanded parent's
    // inlineSubtasks (subtasks may only exist there).
    let task = tasks.find(t => t.id === taskId);
    let subtaskParentId: string | null = null;
    if (!task) {
      for (const [parentId, subs] of Object.entries(inlineSubtasks)) {
        const match = subs.find(s => s.id === taskId);
        if (match) {
          task = match;
          subtaskParentId = parentId;
          break;
        }
      }
    }
    if (!task) return;

    // Helper to patch both `tasks` and any matching entry in `inlineSubtasks`.
    const patchTaskStatus = (newStatus: Task['status']) => {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
      if (subtaskParentId) {
        setInlineSubtasks(prev => {
          const subs = prev[subtaskParentId!];
          if (!subs) return prev;
          return {
            ...prev,
            [subtaskParentId!]: subs.map(s => s.id === taskId ? { ...s, status: newStatus } : s),
          };
        });
      }
    };

    // Going from done → todo: toggle immediately without animation
    if (currentStatus === 'done') {
      patchTaskStatus('todo');
      tasksApi.toggle(projectId, taskId, 'done').then((result) => {
        if (!result.success) {
          patchTaskStatus('done');
          toast.error(t.projects.tasks.failedToUpdateTask);
        }
      });
      return;
    }

    // Parent with at least one open subtask: mark as pending-complete locally,
    // don't persist the status change yet. When every subtask is done the
    // `pendingParentCompletionIds` effect promotes it to a real 'done' status.
    const hasSubtasks = (task.subtaskCount ?? 0) > 0;
    const subtasksForTask = inlineSubtasks[task.id] || [];
    const allSubtasksDone =
      hasSubtasks && subtasksForTask.length > 0 && subtasksForTask.every(s => s.status === 'done');
    if (hasSubtasks && !allSubtasksDone) {
      setPendingParentCompletionIds(prev => {
        if (prev.has(task!.id)) return prev;
        const next = new Set(prev);
        next.add(task!.id);
        return next;
      });
      return;
    }

    // If this is a subtask, persist immediately (no flash animation) so the
    // parent's pendingParentCompletionIds effect can fire as soon as the last
    // subtask is done.
    if (subtaskParentId) {
      patchTaskStatus('done');
      tasksApi.toggle(projectId, taskId, task.status).then((result) => {
        if (!result.success) {
          patchTaskStatus(task!.status);
          toast.error(t.projects.tasks.failedToUpdateTask);
        }
      });
      return;
    }

    // Phase 1 — green flash on the row (CSS animation, 400ms).
    setCompletingTaskIds(prev => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });

    // Fire the API in parallel.
    const apiPromise = tasksApi.toggle(projectId, taskId, task.status);

    // Wait for the flash to finish playing out.
    await new Promise(resolve => setTimeout(resolve, 400));
    const result = await apiPromise;

    // Phase 2 — commit the state change inside a View Transition. The browser
    // snapshots the DOM before and after the synchronous state update and
    // animates between them on the compositor thread. All layout changes
    // (the row leaving, every row below shifting up) are perfectly in sync.
    const commit = () => {
      if (result.success) {
        setTasks(prev => prev.map(t => t.id === taskId
          ? { ...t, status: 'done' as Task['status'] }
          : t
        ));
      } else {
        toast.error((result as any).error || t.projects.tasks.failedToUpdateTask);
      }

      setCompletingTaskIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    };

    const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
    if (typeof doc.startViewTransition === 'function') {
      doc.startViewTransition(() => flushSync(commit));
    } else {
      commit();
    }

    // Fetch the next recurring task (if any) after the view transition kicks off —
    // its arrival in the list will naturally re-render without blocking the animation.
    if (result.success && (result.data as any)?.nextTaskId) {
      const nextResult = await tasksApi.get(projectId, (result.data as any).nextTaskId);
      if (nextResult.success && nextResult.data) {
        setTasks(prev => [transformApiTask(nextResult.data), ...prev]);
        toast.success(t.projects.tasks.nextRecurringCreated);
      }
    }
  }, [canWrite, tasks, projectId, toggleTaskStatus, pendingParentCompletionIds, inlineSubtasks]);

  // When a pending-complete parent has all its subtasks finished, promote it
  // to a real 'done' status via the API. This moves it into the Done group.
  useEffect(() => {
    if (pendingParentCompletionIds.size === 0) return;
    for (const parentId of pendingParentCompletionIds) {
      const subtasks = inlineSubtasks[parentId];
      if (!subtasks || subtasks.length === 0) continue;
      const allDone = subtasks.every(s => s.status === 'done');
      if (!allDone) continue;
      const parent = tasks.find(t => t.id === parentId);
      if (!parent || parent.status === 'done') continue;

      // Persist and flush local state. No flash animation — the parent was
      // already visually "done"; we're just swapping its section.
      setPendingParentCompletionIds(prev => {
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
      tasksApi.toggle(projectId, parentId, parent.status).then((result) => {
        if (result.success) {
          setTasks(prev => prev.map(t => t.id === parentId ? { ...t, status: 'done' as Task['status'] } : t));
        } else {
          toast.error(t.projects.tasks.failedToCompleteTask);
        }
      });
    }
  }, [pendingParentCompletionIds, inlineSubtasks, tasks, projectId]);

  const deleteTask = useCallback(async (taskId: string) => {
    startTransition(async () => {
      const result = await tasksApi.delete(projectId, taskId);

      if (result.success) {
        setTasks(prev => prev.filter((task) => task.id !== taskId));
        toast.success(t.projects.tasks.taskDeleted);
      } else {
        toast.error(result.error || t.projects.tasks.failedToDeleteTask);
      }
    });
  }, [projectId, startTransition]);

  const formatDateShort = useCallback((date: Date | string) => {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }, []);

  const handleStageChange = useCallback(async (taskId: string, stageId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const stage = projectStages.find(s => s.id === stageId);
    if (!stage) return;
    const newStatus = (stage.systemStatus || stage.id) as Task['status'];
    const oldStatus = task.status;
    const oldStageId = task.stageId ?? null;

    // Optimistic update
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, stageId: stage.id, status: newStatus } : t));

    let result;
    if (newStatus === 'done' && oldStatus !== 'done') {
      result = await tasksApi.toggle(projectId, taskId, oldStatus);
      if (result.success) {
        // toggle only flips status; also persist the picked stageId
        await tasksApi.update(projectId, taskId, { stageId: stage.id });
      }
    } else if (newStatus !== 'done' && oldStatus === 'done') {
      result = await tasksApi.toggle(projectId, taskId, 'done');
      if (result.success) {
        await tasksApi.update(projectId, taskId, { stageId: stage.id, status: newStatus });
      }
    } else {
      result = await tasksApi.update(projectId, taskId, { stageId: stage.id, status: newStatus });
    }

    if (result.success) {
      if ((result.data as any)?.nextTaskId) {
        const nextResult = await tasksApi.get(projectId, (result.data as any).nextTaskId);
        if (nextResult.success && nextResult.data) {
          setTasks(prev => [transformApiTask(nextResult.data), ...prev]);
          toast.success(t.projects.tasks.nextRecurringCreated);
        }
      }
    } else {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: oldStatus, stageId: oldStageId } : t));
      toast.error(t.projects.tasks.failedToUpdateTask);
    }
  }, [tasks, projectId, projectStages]);

  const updateTaskInline = useCallback(async (taskId: string, data: Record<string, any>) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...data } : t));
    setSelectedTask(prev => prev?.id === taskId ? { ...prev, ...data } : prev);

    const apiData: Record<string, any> = { ...data };
    if (data.dueDate !== undefined) {
      apiData.dueDate = data.dueDate ? data.dueDate.toISOString() : null;
    }
    if (data.assignees !== undefined) {
      const ids = (data.assignees as { id: string }[] | null | undefined)?.map((a) => a.id) ?? [];
      apiData.assigneeIds = ids.length > 0 ? ids : null;
      delete apiData.assigneeId;
      delete apiData.assignee;
      delete apiData.assignees;
    } else if (data.assigneeId !== undefined) {
      apiData.assigneeIds = data.assigneeId ? [data.assigneeId] : null;
      delete apiData.assigneeId;
      delete apiData.assignee;
      delete apiData.assignees;
    }

    const result = await tasksApi.update(projectId, taskId, apiData);
    if (!result.success) {
      toast.error(t.projects.tasks.failedToUpdateTask);
    }
  }, [projectId]);

  // Filter out subtasks from the main list — they'll be shown inline when parent is expanded
  const topLevelTasks = useMemo(() => tasks.filter(t => !t.parentTaskId), [tasks]);

  // Drag-and-drop handler — commit reorder on drop.
  // In entity mode reorder is a no-op: tasks span multiple projects and have no
  // shared position sequence. DnD is also disabled (isDragEnabled is false) so
  // this handler will not fire in practice, but the guard makes the intent explicit.
  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    if (isEntityMode) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = topLevelTasks.findIndex(t => t.id === active.id);
    const newIndex = topLevelTasks.findIndex(t => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(topLevelTasks, oldIndex, newIndex);

    setTasks(prev => {
      const subtaskItems = prev.filter(t => t.parentTaskId);
      return [...reordered, ...subtaskItems];
    });

    const result = await tasksApi.reorderTasks(projectId, reordered.map(t => t.id));
    if (!result.success) {
      setTasks(prev => {
        const subtaskItems = prev.filter(t => t.parentTaskId);
        return [...arrayMove(reordered, newIndex, oldIndex), ...subtaskItems];
      });
      toast.error(t.projects.tasks.failedToReorderTasks);
    }
  }, [isEntityMode, topLevelTasks, projectId]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: t.projects.tasks.filterStatus,
      options: [
        { value: 'todo', label: t.projects.tasks.filterTodoOpt },
        { value: 'in_progress', label: t.projects.tasks.filterInProgressOpt },
        { value: 'done', label: t.projects.tasks.filterDoneOpt },
      ],
    },
    {
      field: 'priority',
      label: t.projects.tasks.filterPriority,
      options: [
        { value: 'low', label: t.projects.tasks.priorityLow },
        { value: 'medium', label: t.projects.tasks.priorityMedium },
        { value: 'high', label: t.projects.tasks.priorityHigh },
        { value: 'urgent', label: t.projects.tasks.priorityUrgent },
      ],
    },
    {
      field: 'label',
      label: t.projects.tasks.filterLabel,
      options: availableLabels.map(l => ({ value: l.id, label: l.name })),
    },
  ], [availableLabels, t]);

  // Resolve a task to its pipeline stage. Prefer `stageId`; fall back to matching
  // the task's `status` against each stage's `systemStatus` (for legacy tasks that
  // predate stageId being set).
  const getTaskStage = useCallback((task: Task) => {
    if (task.stageId) {
      const byId = projectStages.find(s => s.id === task.stageId);
      if (byId) return byId;
    }
    return projectStages.find(s => s.systemStatus === task.status);
  }, [projectStages]);

  // Group configs vary by the active "Group by" choice. Returning [] tells
  // EntityList to render a single ungrouped section.
  const groupConfigs: GroupConfig<Task>[] = useMemo(() => {
    if (groupBy === 'none') return [];

    if (groupBy === 'priority') {
      return [
        { id: 'urgent', label: t.projects.tasks.priorityUrgent, sortOrder: 1, filter: (t) => t.priority === 'urgent' },
        { id: 'high', label: t.projects.tasks.priorityHigh, sortOrder: 2, filter: (t) => t.priority === 'high' },
        { id: 'medium', label: t.projects.tasks.priorityMedium, sortOrder: 3, filter: (t) => t.priority === 'medium' },
        { id: 'low', label: t.projects.tasks.priorityLow, sortOrder: 4, filter: (t) => t.priority === 'low' },
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
        { id: 'overdue', label: t.projects.tasks.groupOverdue, sortOrder: 1, filter: (t) => !!t.dueDate && t.dueDate < startOfToday },
        { id: 'today', label: t.projects.tasks.groupToday, sortOrder: 2, filter: (t) => !!t.dueDate && t.dueDate >= startOfToday && t.dueDate < startOfTomorrow },
        { id: 'thisWeek', label: t.projects.tasks.groupThisWeek, sortOrder: 3, filter: (t) => !!t.dueDate && t.dueDate >= startOfTomorrow && t.dueDate < startOfNextWeek },
        { id: 'later', label: t.projects.tasks.groupLater, sortOrder: 4, filter: (t) => !!t.dueDate && t.dueDate >= startOfNextWeek },
        { id: 'no-date', label: t.projects.tasks.groupNoDate, sortOrder: 5, filter: (t) => !t.dueDate },
      ];
    }

    if (groupBy === 'assignee') {
      const memberGroups: GroupConfig<Task>[] = projectMembers.map((m, i) => {
        const name = m.user?.name || 'Unknown';
        const initials = name
          .split(' ')
          .map(part => part[0])
          .filter(Boolean)
          .slice(0, 2)
          .join('')
          .toUpperCase();
        return {
          id: `assignee-${m.userId}`,
          label: name,
          sortOrder: i + 1,
          leadingContent: (
            <Avatar className="h-4 w-4 rounded-[5.5px] -translate-y-px">
              {m.user?.avatar && <AvatarImage src={m.user.avatar} alt={name} />}
              <AvatarFallback className="rounded-[5.5px] text-[8px] font-medium">{initials || '?'}</AvatarFallback>
            </Avatar>
          ),
          filter: (t: Task) => {
            const ids = t.assigneeIds && t.assigneeIds.length > 0
              ? t.assigneeIds
              : (t.assigneeId ? [t.assigneeId] : []);
            return ids.includes(m.userId);
          },
        };
      });
      memberGroups.push({
        id: 'unassigned',
        label: t.projects.tasks.groupUnassigned,
        sortOrder: projectMembers.length + 1,
        filter: (t) => {
          const ids = t.assigneeIds && t.assigneeIds.length > 0
            ? t.assigneeIds
            : (t.assigneeId ? [t.assigneeId] : []);
          return ids.length === 0;
        },
      });
      return memberGroups;
    }

    // Default: status (one group per project stage, falling back to todo/in_progress/done).
    if (projectStages.length === 0) {
      return [
        { id: 'todo', label: t.projects.tasks.groupTodo, sortOrder: 1, filter: (t) => t.status === 'todo' },
        { id: 'in_progress', label: t.projects.tasks.groupInProgress, sortOrder: 2, filter: (t) => t.status === 'in_progress' },
        { id: 'done', label: t.projects.tasks.groupDone, sortOrder: 3, filter: (t) => t.status === 'done' },
      ];
    }
    return projectStages.map((stage, i) => ({
      id: stage.id,
      label: stage.name,
      sortOrder: i + 1,
      filter: (t: Task) => {
        const s = getTaskStage(t);
        return s?.id === stage.id;
      },
    }));
  }, [groupBy, projectStages, getTaskStage, projectMembers, t]);

  const groupByOptions = [
    { value: 'status' as const, label: t.projects.tasks.groupByStatus },
    { value: 'priority' as const, label: t.projects.tasks.groupByPriority },
    { value: 'dueDate' as const, label: t.projects.tasks.groupByDueDate },
    { value: 'assignee' as const, label: t.projects.tasks.groupByAssignee },
    { value: 'none' as const, label: t.projects.tasks.groupByNone },
  ];
  const groupByLabel = groupByOptions.find(o => o.value === groupBy)?.label ?? t.projects.tasks.groupByStatus;

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
      } else if (filter.field === 'label') {
        result = filter.operator === 'is'
          ? result.filter(t => Array.isArray((t as any).labels) && (t as any).labels.includes(filter.value))
          : result.filter(t => !Array.isArray((t as any).labels) || !(t as any).labels.includes(filter.value));
      }
    });
    return result;
  }, []);

  // Sorting
  const handleSort = useCallback((columnId: string) => {
    setSortState(prev => {
      if (prev?.columnId === columnId) {
        // Toggle: asc → desc → clear
        if (prev.direction === 'asc') return { columnId, direction: 'desc' };
        return null;
      }
      return { columnId, direction: 'asc' };
    });
  }, []);

  const statusOrder = ['todo', 'in_progress', 'review', 'done', 'cancelled'];
  const priorityOrder = ['low', 'medium', 'high', 'urgent'];

  const sortedTasks = useMemo(() => {
    if (!sortState) return topLevelTasks;
    const { columnId, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;

    const stageIndex = (t: Task) => {
      const s = getTaskStage(t);
      if (s) {
        const idx = projectStages.findIndex(ps => ps.id === s.id);
        if (idx !== -1) return idx;
      }
      return statusOrder.indexOf(t.status);
    };

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
          cmp = (stageIndex(a) - stageIndex(b)) * dir;
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
      }
      return cmp !== 0 ? cmp : tiebreak(a, b);
    });
  }, [tasks, sortState, topLevelTasks, getTaskStage, projectStages]);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'checkbox', header: t.projects.tasks.headerTask, width: 'w-4 flex-shrink-0' },
    { id: 'task', header: '', width: 'min-w-[200px] flex-1' },
    { id: 'status', header: t.projects.tasks.headerStatus, width: 'w-[120px]', sortable: true },
    { id: 'priority', header: t.projects.tasks.headerPriority, width: 'w-[100px]', sortable: true },
    { id: 'dueDate', header: t.projects.tasks.headerDue, width: 'w-[100px]', sortable: true },
    { id: 'assignee', header: t.projects.tasks.headerAssignee, width: 'w-[120px]', sortable: true },
  ], [t]);

  // Render a single task row (reused for top-level and subtask rows). `depth`
  // is the nesting level WITHIN the subtree (0 = direct child of a top-level
  // task). It's folded into paddingLeft so the row's hover background covers
  // the full width — wrapping the row in an outer padded div would leave a
  // flat strip on the left that doesn't pick up `hover:bg-gray-50`.
  const renderTaskRow = useCallback((task: Task, isSubtask: boolean, depth: number = 0) => {
    const stage = getTaskStage(task);
    const statusFallback = statusConfig[task.status] || statusConfig.todo;
    const priority = priorityConfig[task.priority] || priorityConfig.medium;
    const hasSubtasks = (task.subtaskCount ?? 0) > 0;
    const isExpanded = expandedTaskIds.has(task.id);
    const isCompleting = completingTaskIds.has(task.id);
    const isPendingComplete = pendingParentCompletionIds.has(task.id);
    // Visually-done = actually done OR pending (parent waiting on subtasks).
    const isVisuallyDone = task.status === 'done' || isPendingComplete;

    return (
      <div
        key={task.id}
        onClick={() => setSelectedTask(task)}
        className={cn(
          "flex items-center gap-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer group",
          !isSubtask && "border-b border-gray-200/70 dark:border-border",
          isVisuallyDone && !isCompleting && "opacity-50",
          isCompleting && "task-completing-inner"
        )}
        style={{ paddingLeft: isSubtask ? 48 + depth * 32 : 16, paddingRight: 16 }}
      >
        {/* Checkbox */}
        <div className="flex-shrink-0 translate-y-[1px]" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={isVisuallyDone || isCompleting}
            onCheckedChange={() => handleCheckboxToggle(task.id, task.status)}
            disabled={isPending || !canWrite || isCompleting}
            className="h-4 w-4"
          />
        </div>

        {/* Task Title */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2">
          <span className={cn(
            "text-sm font-medium truncate min-w-0",
            isVisuallyDone ? "line-through text-gray-400" : "text-gray-900 dark:text-foreground"
          )}>
            {task.title}
          </span>
          {hasSubtasks && (
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); toggleExpandTask(task.id); }}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-gray-200 dark:hover:bg-gray-700 transition-[opacity,color,background-color] flex-shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
          {((task.dependsOn?.length ?? 0) > 0 || (task.blocks?.length ?? 0) > 0) && (
            <div className="flex items-center flex-shrink-0 text-gray-400 dark:text-muted-foreground">
              <Link className="h-3 w-3" />
            </div>
          )}
        </div>

        {/* Attachments & Subtask count */}
        <div className="w-[60px] flex justify-end gap-1">
          {(task.attachmentCount ?? 0) > 0 && (
            <span className="-translate-y-[1.5px] inline-flex items-center justify-center gap-1.5 h-[22px] px-1.5 text-[11px] leading-none font-mono tabular-nums text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border rounded-[5px] flex-shrink-0">
              <Paperclip className="h-3 w-3 shrink-0" />
              {task.attachmentCount}
            </span>
          )}
          {(task.subtaskCount ?? 0) > 0 && (
            <span className="-translate-y-[0.5px] inline-flex items-center justify-center gap-1.5 h-[22px] px-1.5 text-[11px] leading-none font-mono tabular-nums text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border rounded-[5px] flex-shrink-0">
              <ListTodo className="h-3 w-3 shrink-0" />
              {task.completedSubtaskCount}/{task.subtaskCount}
            </span>
          )}
        </div>

        {/* Status */}
        <div className="w-[120px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn("-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow", statusFallback.color, statusFallback.bg)}>
                {stage?.name ?? statusFallback.label}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {projectStages.length > 0 ? (
                projectStages.map(s => (
                  <Button
                    key={s.id}
                    variant="ghost"
                    onClick={() => handleStageChange(task.id, s.id)}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4"
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                      <span>{s.name}</span>
                    </span>
                    {(stage?.id ?? null) === s.id && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                ))
              ) : (
                Object.entries(statusConfig).map(([key, config]) => (
                  <Button
                    key={key}
                    variant="ghost"
                    onClick={() => handleStageChange(task.id, key)}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4"
                  >
                    <span>{config.label}</span>
                    {task.status === key && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                ))
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Priority */}
        <div className="w-[100px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn("-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow", priority.color, priority.bg)}>
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
                    <span>{t.projects.tasks.clearDate}</span>
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Assignee(s) */}
        <div className="w-[120px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  'cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded-[6px] pl-0.5 py-0.5 transition-shadow',
                  // When multiple avatars are stacked (no name shown), match the left-side padding
                  task.assignees && task.assignees.length > 1 ? 'pr-0.5' : 'pr-1.5',
                )}
              >
                {task.assignees && task.assignees.length > 0 ? (
                  <div className="flex items-center">
                    <div className="flex -space-x-1.5">
                      {task.assignees.slice(0, 3).map((a) => {
                        const memberAvatar =
                          projectMembers.find((m) => m.userId === a.id)?.user?.avatar;
                        const src = a.avatar || memberAvatar;
                        const multiple = (task.assignees?.length ?? 0) > 1;
                        const avatar = (
                          <Avatar
                            key={a.id}
                            className="h-5 w-5 !rounded-[7px] ring-1 ring-background"
                            title={multiple ? undefined : a.name}
                          >
                            {src && <AvatarImage src={src} alt={a.name} className="!rounded-[7px]" />}
                            <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                              {a.name.charAt(0).toUpperCase()}
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
                      {task.assignees.length > 3 && (
                        <div className="relative z-10 w-5 h-5 rounded-[7px] bg-[#dcdce0] dark:bg-accent flex items-center justify-center ring-1 ring-background">
                          <span className="text-[9.5px] font-mono font-medium text-gray-600 dark:text-muted-foreground">
                            +{task.assignees.length - 3}
                          </span>
                        </div>
                      )}
                    </div>
                    {task.assignees.length === 1 && (
                      <span className="text-sm text-gray-600 dark:text-muted-foreground truncate ml-1.5">
                        {task.assignees[0].name.split(' ')[0]}
                      </span>
                    )}
                  </div>
                ) : task.assignee ? (
                  (() => {
                    const memberAvatar = task.assigneeId
                      ? projectMembers.find((m) => m.userId === task.assigneeId)?.user?.avatar
                      : undefined;
                    return (
                      <div className="flex items-center gap-1.5">
                        <Avatar className="h-5 w-5 !rounded-[7px]">
                          {memberAvatar && (
                            <AvatarImage src={memberAvatar} alt={task.assignee} className="!rounded-[7px]" />
                          )}
                          <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                            {task.assignee.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm text-gray-600 dark:text-muted-foreground truncate">
                          {task.assignee.split(' ')[0]}
                        </span>
                      </div>
                    );
                  })()
                ) : (
                  <span className="text-sm text-gray-400">—</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {projectMembers.filter(m => m.user?.name).map((member) => {
                const currentAssignees = task.assignees ?? [];
                const isSelected = currentAssignees.some((a) => a.id === member.userId);
                return (
                  <Button
                    key={member.userId}
                    variant="ghost"
                    onClick={() => {
                      const nextAssignees = isSelected
                        ? currentAssignees.filter((a) => a.id !== member.userId)
                        : [
                            ...currentAssignees,
                            { id: member.userId, name: member.user!.name, avatar: member.user?.avatar },
                          ];
                      const primary = nextAssignees[0];
                      updateTaskInline(task.id, {
                        assigneeId: primary?.id ?? null,
                        assignee: primary?.name,
                        assignees: nextAssignees,
                      });
                    }}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4"
                  >
                    <span className="flex items-center gap-2">
                      <Avatar className="h-5 w-5 !rounded-[7px]">
                        {member.user?.avatar && (
                          <AvatarImage
                            src={member.user.avatar}
                            alt={member.user!.name}
                            className="!rounded-[7px]"
                          />
                        )}
                        <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                          {member.user!.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span>{member.user!.name}</span>
                    </span>
                    {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                );
              })}
              {(task.assignee || (task.assignees && task.assignees.length > 0)) && (
                <>
                  <div className="h-px bg-border my-1" />
                  <Button
                    variant="ghost"
                    onClick={() => updateTaskInline(task.id, { assigneeId: null, assignee: undefined, assignees: [] })}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    <span>{t.projects.tasks.clearAssignee}</span>
                  </Button>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Actions - only show for users with write permission */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          {canWrite && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => {
                  setEditingCrmTask(toCrmTask(task, projectMembers, availableCompanies));
                  setShowAddDialog(true);
                }}>
                  <Pencil className="h-3.5 w-3.5 mr-0.5" />
                  {t.projects.tasks.editTaskItem}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => {
                  startTransition(async () => {
                    // In entity mode use the task's own projectId (tasks span multiple projects).
                    const dupProjectId = (isEntityMode ? (task as any).projectId : null) ?? projectId;
                    const result = await tasksApi.create(dupProjectId, {
                      title: `${task.title} (copy)`,
                      description: task.description,
                      status: task.status,
                      priority: task.priority,
                    });
                    if (result.success && result.data) {
                      setTasks(prev => [transformApiTask(result.data), ...prev]);
                      toast.success(t.projects.tasks.taskDuplicated);
                    }
                  });
                }}>
                  <Copy className="h-3.5 w-3.5 mr-0.5" />
                  {t.projects.tasks.duplicateTaskItem}
                </DropdownMenuItem>
                {showMoveTask && (
                  <DropdownMenuItem onClick={() => setMovingTaskId(task.id)}>
                    <FolderInput className="h-3.5 w-3.5 mr-0.5" />
                    {t.projects.tasks.moveTaskItem}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950" onClick={() => deleteTask(task.id)}>
                  <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-600" />
                  {t.projects.tasks.deleteTaskItem}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  }, [isPending, canWrite, toggleTaskStatus, deleteTask, availableLabels, expandedTaskIds, toggleExpandTask, handleStageChange, getTaskStage, projectStages, updateTaskInline, projectMembers, formatDateShort, startTransition, projectId, completingTaskIds, handleCheckboxToggle, pendingParentCompletionIds, showMoveTask, t]);

  // Subtask container — keeps the rows mounted and toggles visibility via
  // `hidden`. Unmounting/remounting dozens of nested rows on every click is
  // what caused the collapse-after-click lag; a class/attribute flip is
  // effectively free and lets the browser reuse the existing DOM nodes.
  const SubtaskContainer = useMemo(() => {
    return function SubtaskContainerInner({ isExpanded, children }: { isExpanded: boolean; children: React.ReactNode }) {
      return (
        <div hidden={!isExpanded} aria-hidden={!isExpanded}>
          {children}
        </div>
      );
    };
  }, []);

  // Recursively render a subtree: the task's row, then its inline subtasks
  // underneath, which can themselves have subtasks. Each deeper level adds
  // indentation so the tree reads as nested.
  //
  // The row and its nested children MUST live in separate wrappers: the tree
  // connector lines (half-line + elbow + continuation) are absolutely
  // positioned with percentage-based heights, so if we stuff the descendants
  // inside the same `relative` parent as the row, the lines stretch across
  // every descendant row and produce a glitchy criss-cross. Keeping them
  // siblings bounds the row's own lines to one row height.
  const renderSubtaskList = useCallback((parent: Task, depth: number): React.ReactNode => {
    const isExpanded = expandedTaskIds.has(parent.id);
    const childTasks = inlineSubtasks[parent.id] || [];
    const hasSubtasks = (parent.subtaskCount ?? 0) > 0;
    if (!hasSubtasks || childTasks.length === 0) return null;
    return (
      <SubtaskContainer isExpanded={isExpanded}>
        {childTasks.map((sub, index) => {
          const isLast = index === childTasks.length - 1;
          // Each nesting level shifts the tree guide right by 28px so the
          // elbow sits under this subtree's own parent checkbox, not the
          // top-level one.
          const guideLeft = 22 + depth * 32;
          const nestedContent = renderSubtaskList(sub, depth + 1);
          return (
            <React.Fragment key={sub.id}>
              {/* The subtask row + its tree elbow. Lines here are bounded to
                  this row's height by the `relative` wrapper. */}
              <div className="relative border-b border-gray-200/70 dark:border-border">
                <div style={{ position: 'absolute', left: guideLeft, top: 0, height: 'calc(50% - 5px)', width: 1, backgroundColor: 'var(--color-border)', zIndex: 1 }} />
                <div style={{ position: 'absolute', left: guideLeft, top: 'calc(50% - 6px)', width: 10, height: 8, borderLeft: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)', borderRadius: '0 0 0 6px', zIndex: 1 }} />
                {!isLast && (
                  <div style={{ position: 'absolute', left: guideLeft, top: 'calc(50% + 2px)', bottom: 0, width: 1, backgroundColor: 'var(--color-border)', zIndex: 1 }} />
                )}
                {renderTaskRow(sub, true, depth)}
              </div>
              {/* Nested descendants live OUTSIDE the row wrapper. If this sub
                  isn't the last sibling at its level, we extend the parent
                  level's guide vertically through the whole nested block so
                  the tree reads as continuous. */}
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
      </SubtaskContainer>
    );
  }, [expandedTaskIds, inlineSubtasks, renderTaskRow, SubtaskContainer]);

  // Wrap renderTaskRow to include inline subtasks with tree view when expanded
  const renderRow = useCallback((task: Task, handlers: RowHandlers<Task>) => {
    const rowContent = (
      <React.Fragment key={task.id}>
        {renderTaskRow(task, false)}
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

  return (
    <>
      <DndContext
        sensors={dndSensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
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
            sortState={sortState}
            onSort={handleSort}
            renderRow={renderRow}
            leftActionButtons={groupByMenu}
            searchPlaceholder={t.projects.tasks.searchPlaceholder}
            searchFields={['title', 'description', 'assignee']}
            searchQuery={searchQueryProp}
            onSearchChange={onSearchChange}
            activeFilters={activeFiltersProp}
            onFiltersChange={onFiltersChange}
            hasMore={hasNextPage}
            isLoadingMore={isFetchingNextPage}
            onLoadMore={onLoadMore}
            topBarClassName="pt-2 pb-2"
            emptyStateClassName="min-h-[calc(100dvh-350px)]"
        createButton={canWrite ? {
          label: t.projects.tasks.addTaskBtn,
          // Both modes open the task dialog. In entity mode the dialog shows a
          // project picker (`availableProjects`) and the entity link is injected
          // on save — see handleTaskDialogSave.
          onClick: () => setShowAddDialog(true),
        } : undefined}
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
          title: t.projects.tasks.noTasksTitle,
          description: t.projects.tasks.noTasksDesc,
          action: canWrite ? {
            label: t.projects.tasks.addTaskBtn,
            onClick: () => setShowAddDialog(true),
          } : undefined,
        }}
        noResultsState={{
          title: t.projects.tasks.noTasksTitle,
          description: t.projects.tasks.noResultsDesc,
        }}
      />
        </SortableContext>
      </DndContext>

      {/* Add/Edit Task Dialog */}
      <TaskDialog
        open={showAddDialog}
        onOpenChange={(open) => {
          setShowAddDialog(open);
          if (!open) setEditingCrmTask(null);
        }}
        editingTask={editingCrmTask}
        availableAssignees={projectMembers.filter(m => m.user?.name).map(m => ({ id: m.userId, name: m.user!.name, avatar: m.user?.avatar }))}
        availableCompanies={availableCompanies}
        availableLabels={availableLabels}
        availableStatuses={projectStages.map(s => ({ id: s.id, label: s.name, color: s.color }))}
        onCreateLabel={handleCreateLabel}
        hideRecord
        onSave={handleTaskDialogSave}
        projectId={projectId}
        onUpdate={(taskId, data) => {
          const projectData: Record<string, any> = {};
          if (data.title) projectData.title = data.title;
          if (data.description !== undefined) projectData.description = data.description;
          if (data.status) {
            const picked = projectStages.find(s => s.id === data.status);
            if (picked) {
              projectData.stageId = picked.id;
              projectData.status = picked.systemStatus;
            } else {
              projectData.status = statusFromCrm[data.status] || data.status;
            }
          }
          if (data.priority) projectData.priority = data.priority;
          if (data.dueDate !== undefined) projectData.dueDate = data.dueDate?.toISOString();
          if (data.labels !== undefined) projectData.labels = data.labels;
          if ((data as any).repeat !== undefined) projectData.repeat = (data as any).repeat;

          startTransition(async () => {
            const result = await tasksApi.update(projectId, taskId, projectData);
            if (result.success) {
              setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...projectData } : t));
              setSelectedTask(prev => prev?.id === taskId ? { ...prev, ...projectData } : prev);
              setShowAddDialog(false);
              setEditingCrmTask(null);
              toast.success(t.projects.tasks.taskUpdated);
            } else {
              toast.error(t.projects.tasks.failedToUpdateTask);
            }
          });
        }}
        isPending={isCreatingTask}
      />

      {/* Subtask Dialog */}
      <TaskDialog
        open={showSubtaskDialog}
        onOpenChange={setShowSubtaskDialog}
        editingTask={null}
        availableAssignees={projectMembers.filter(m => m.user?.name).map(m => ({ id: m.userId, name: m.user!.name, avatar: m.user?.avatar }))}
        availableCompanies={availableCompanies}
        availableLabels={availableLabels}
        availableStatuses={projectStages.map(s => ({ id: s.id, label: s.name, color: s.color }))}
        onCreateLabel={handleCreateLabel}
        hideRecord
        projectId={projectId}
        onSave={handleSaveSubtask}
        onUpdate={() => {}}
        isPending={isCreatingTask}
      />

      {/* Move task to another project (weldflow-move-task flag) */}
      {showMoveTask && movingTaskId && (
        <MoveTaskDialog
          open={!!movingTaskId}
          onOpenChange={(open) => { if (!open) setMovingTaskId(null); }}
          taskId={movingTaskId}
          currentProjectId={projectId}
          onMoved={() => {
            // The moved task left this project — drop it from the local list.
            setTasks((prev) => prev.filter((task) => task.id !== movingTaskId));
            setMovingTaskId(null);
          }}
        />
      )}

      {/* Task detail panel is now rendered globally via ObjectPanelHost. */}
    </>
  );
}
