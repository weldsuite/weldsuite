
import React, { useState, useMemo, useTransition, useEffect, useLayoutEffect, useCallback, useRef, useContext } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useI18n } from '@/lib/i18n/provider';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { useStageLabel } from '../../../lib/stage-labels';
import { flushSync } from 'react-dom';
import { useOptionalBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useCompanies } from '@/components/objects/company/use-company-data';
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
import { Badge } from '@weldsuite/ui/components/badge';
import { useObjectPanel } from '@/components/object-panel';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
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
  Repeat,
  ListTodo,
  Paperclip,
  Link,
  ChevronRight,
  FolderInput,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { tasksApi, membersApi, labelsApi, stagesApi } from '@/app/weldflow/lib/api-client';
import { useFeatureFlag } from '@/hooks/queries/use-feature-flags-queries';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import { buildEntityAssigneeDirectory } from './entity-assignees';
import { MoveTaskDialog } from '@/components/weldflow/move-task-dialog';
import { TaskNumberBadge } from '@/components/weldflow/task-number-badge';
import { LabelOverflowList } from '@/app/weldflow/lib/label-overflow-list';
import type { Projects } from '@/lib/api/types/apps/projects.types';
import { ProjectPermissionContext } from '@/app/weldflow/contexts/project-permission-context';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type SortState } from '@/components/entity-list';
import { TaskDialog } from '@/app/weldcrm/task-dialog';

interface Task {
  id: string;
  /** Workspace-wide sequential number, rendered as the bare number. */
  number?: number | null;
  title: string;
  description?: string;
  stageId?: string | null;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'testing' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee?: string;
  assigneeId?: string | null;
  assigneeIds?: string[];
  assignees?: { id: string; name: string; email?: string; avatar?: string }[];
  dueDate?: Date;
  /** Minutes; shown/edited in the task dialog, saved on the `tasks.duration` column. */
  duration?: number;
  createdAt: Date;
  tags?: string[];
  labels?: string[];
  customFields?: Record<string, unknown>;
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

interface ProjectMember {
  userId: string;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

// Raw pipeline-stage row from `stagesApi.list` (`project-pipeline-stages`).
interface RawStage {
  id: string;
  name: string;
  color?: string | null;
  position?: number | null;
  systemStatus?: string | null;
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
   * group-by, project stages, breadcrumbs) are suppressed. Assignees come from
   * the workspace member directory instead of a per-project member list.
   */
  entityScope?: { kind: 'company' | 'person'; id: string };
}

// priorityConfig and statusConfig are built inside TasksClient (need t for labels)

// The task API route returns richer payloads than `Projects.ProjectTask` documents
// (nested children for includeSubtasks=true, computed counts, custom fields). This
// shape captures what `transformApiTask` actually reads off the response — all
// additions are optional so a plain `Projects.ProjectTask` still satisfies it.
interface RawApiTask extends Projects.ProjectTask {
  stageId?: string | null;
  customerId?: string | null;
  customFields?: Record<string, unknown> | null;
  attachmentsCount?: number;
  _count?: { attachments?: number };
  subtaskCount?: number;
  completedSubtaskCount?: number;
  repeat?: { frequency: string; interval?: number; unit?: string } | null;
  duration?: number | null;
  children?: RawApiTask[];
}

// Transform API task to local Task format
function transformApiTask(apiTask: RawApiTask): Task {
  const rawChildren = apiTask.children;
  const attachmentsFromCustomFields = Array.isArray(apiTask.customFields?.attachments)
    ? (apiTask.customFields.attachments as unknown[]).length
    : 0;
  return {
    id: apiTask.id,
    number: apiTask.number ?? null,
    title: apiTask.title,
    description: apiTask.description || undefined,
    stageId: apiTask.stageId ?? null,
    status: (apiTask.status as Task['status']) || 'todo',
    priority: (apiTask.priority as Task['priority']) || 'medium',
    assignee: apiTask.assignee?.name || undefined,
    assigneeId: apiTask.assigneeId || undefined,
    assigneeIds: apiTask.assigneeIds || (apiTask.assigneeId ? [apiTask.assigneeId] : undefined),
    assignees: apiTask.assignees || (apiTask.assignee ? [apiTask.assignee] : undefined),
    dueDate: apiTask.dueDate ? new Date(apiTask.dueDate) : undefined,
    duration: apiTask.duration ?? undefined,
    createdAt: new Date(apiTask.createdAt),
    tags: apiTask.tags || undefined,
    labels: apiTask.labels || undefined,
    customFields: apiTask.customFields || undefined,
    attachmentCount: apiTask.attachmentsCount || apiTask._count?.attachments || attachmentsFromCustomFields,
    parentTaskId: apiTask.parentTaskId || null,
    customerId: apiTask.customerId ?? null,
    projectId: apiTask.projectId ?? null,
    dependsOn: apiTask.dependsOn || [],
    blocks: apiTask.blocks || [],
    subtaskCount: apiTask.subtaskCount || 0,
    completedSubtaskCount: apiTask.completedSubtaskCount || 0,
    key: apiTask.key || undefined,
    repeat: apiTask.repeat || undefined,
    children: Array.isArray(rawChildren) ? rawChildren.map((child) => transformApiTask(child)) : undefined,
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

// Sort-order lookups for the board's "Sort by status/priority" columns — static,
// so these live at module scope instead of being recreated (with a new array
// identity) on every render.
const STATUS_SORT_ORDER = ['todo', 'in_progress', 'review', 'done', 'cancelled'];
const PRIORITY_SORT_ORDER = ['low', 'medium', 'high', 'urgent'];

// Entity mode embeds the board in a ~400px object panel (or in the column next
// to the chat when the panel is expanded), but the full column set needs ~820px
// and the cells have fixed widths, so the right-hand columns (priority first)
// ended up cut off by the panel edge. The board is wrapped in an `@container`
// (`EntityContainerScope`), and the secondary columns drop out by the board's
// own width rather than the viewport's: below 820px the status column (the
// groups already say it) and the counts go, below 560px the assignee goes too
// and what is left tightens up. Header and row cells share these classes so
// they stay aligned. They are only applied in entity mode; outside it there is
// no `@container`, and the project board keeps its full layout.
const ENTITY_HIDE_WHEN_COMPACT = '@max-[820px]:hidden';
const ENTITY_HIDE_WHEN_NARROW = '@max-[560px]:hidden';
const ENTITY_NARROW_TITLE = '@max-[560px]:min-w-0';
const ENTITY_NARROW_PRIORITY = '@max-[560px]:w-[80px]';
const ENTITY_NARROW_DUE = '@max-[560px]:w-[68px]';
const ENTITY_NARROW_ACTIONS = '@max-[560px]:w-[28px]';
const ENTITY_NARROW_GAP = '@max-[560px]:gap-2';

/** Makes the board a size container in entity mode; a no-op wrapper elsewhere. */
function EntityContainerScope({ enabled, children }: Readonly<{ enabled: boolean; children: React.ReactNode }>) {
  return enabled ? <div className="@container min-w-0 w-full">{children}</div> : <>{children}</>;
}

function toCrmTask(
  task: Task,
  projectMembers: ProjectMember[],
  availableCompanies: { id: string; name: string; avatar?: string }[] = [],
): CrmTask & { assignees?: { id: string; name: string; avatar?: string }[]; customFields?: Record<string, unknown>; linkedCompany?: { id: string; name: string; avatar?: string } } {
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
    duration: task.duration,
    createdAt: task.createdAt,
    labels: task.labels,
    customFields: task.customFields,
    repeat: task.repeat || undefined,
    linkedCompany: linkedCompany || undefined,
    scheduledStart: task.scheduledStart ? new Date(task.scheduledStart) : null,
    scheduledEnd: task.scheduledEnd ? new Date(task.scheduledEnd) : null,
    autoScheduled: task.autoScheduled ?? null,
  } as CrmTask & { assignees?: { id: string; name: string }[]; customFields?: Record<string, unknown>; repeat?: { frequency: string; interval?: number; unit?: string }; linkedCompany?: { id: string; name: string; avatar?: string } };
}

const restrictToVerticalAxis = ({ transform }: { transform: { x: number; y: number; scaleX: number; scaleY: number } }) => ({
  ...transform,
  x: 0,
});

// Look for a task in the main list first, then in any expanded parent's
// inlineSubtasks (subtasks may only exist there).
function findTaskWithParent(
  tasks: Task[],
  inlineSubtasks: Record<string, Task[]>,
  taskId: string,
): { task: Task | undefined; subtaskParentId: string | null } {
  const task = tasks.find((t) => t.id === taskId);
  if (task) return { task, subtaskParentId: null };
  for (const [parentId, subs] of Object.entries(inlineSubtasks)) {
    const match = subs.find((s) => s.id === taskId);
    if (match) return { task: match, subtaskParentId: parentId };
  }
  return { task: undefined, subtaskParentId: null };
}

// Ids of a task and every subtask below it, from both the main list and the
// inlineSubtasks cache — deleting a task removes its whole subtree.
function collectSubtreeIds(
  tasks: Task[],
  inlineSubtasks: Record<string, Task[]>,
  rootId: string,
): Set<string> {
  const ids = new Set([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const children = [...(inlineSubtasks[id] ?? []), ...tasks.filter((t) => t.parentTaskId === id)];
      for (const child of children) {
        if (ids.has(child.id)) continue;
        ids.add(child.id);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return ids;
}

// Assignee ids for a task: the multi-assignee list when present, otherwise the
// single legacy assignee.
function getTaskAssigneeIds(task: Task): string[] {
  if (task.assigneeIds && task.assigneeIds.length > 0) return task.assigneeIds;
  return task.assigneeId ? [task.assigneeId] : [];
}

// Commit a synchronous state update inside a View Transition when the browser
// supports it, otherwise run it directly.
function runInViewTransition(commit: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(() => flushSync(commit));
  } else {
    commit();
  }
}

// Persist a stage pick. Moving into/out of 'done' goes through the toggle
// endpoint (which handles recurrence), then the stage/status is saved on top.
async function persistStageChange(
  projectId: string,
  taskId: string,
  stageId: string,
  oldStatus: Task['status'],
  newStatus: Task['status'],
) {
  if (newStatus === 'done' && oldStatus !== 'done') {
    const result = await tasksApi.toggle(projectId, taskId, oldStatus);
    if (result.success) {
      // toggle only flips status; also persist the picked stageId
      await tasksApi.update(projectId, taskId, { stageId });
    }
    return result;
  }
  if (newStatus !== 'done' && oldStatus === 'done') {
    const result = await tasksApi.toggle(projectId, taskId, 'done');
    if (result.success) {
      await tasksApi.update(projectId, taskId, { stageId, status: newStatus });
    }
    return result;
  }
  return tasksApi.update(projectId, taskId, { stageId, status: newStatus });
}

function repeatBadgeLabel(repeat: NonNullable<Task['repeat']>): string {
  if (repeat.frequency === 'custom' && repeat.interval && repeat.unit) {
    return `${repeat.interval}${repeat.unit.charAt(0)}`;
  }
  if (repeat.frequency === 'biweekly') return '2w';
  return repeat.frequency.charAt(0).toUpperCase();
}

type TaskAssigneeEntry = NonNullable<Task['assignees']>[number];

function AssigneeStackAvatar({ assignee, src, multiple }: Readonly<{ assignee: TaskAssigneeEntry; src: string | undefined; multiple: boolean }>) {
  const avatar = (
    <Avatar
      className="h-5 w-5 !rounded-[7px] ring-1 ring-background"
      title={multiple ? undefined : assignee.name}
    >
      {src && <AvatarImage src={src} alt={assignee.name} className="!rounded-[7px]" />}
      <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
        {assignee.name.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
  if (!multiple) return avatar;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span className="inline-flex">{avatar}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {assignee.name}
      </TooltipContent>
    </Tooltip>
  );
}

function AssigneeStack({ assignees, projectMembers }: Readonly<{ assignees: TaskAssigneeEntry[]; projectMembers: ProjectMember[] }>) {
  const multiple = assignees.length > 1;
  return (
    <div className="flex items-center">
      <div className="flex -space-x-1.5">
        {assignees.slice(0, 3).map((a) => {
          const memberAvatar = projectMembers.find((m) => m.userId === a.id)?.user?.avatar;
          return <AssigneeStackAvatar key={a.id} assignee={a} src={a.avatar || memberAvatar} multiple={multiple} />;
        })}
        {assignees.length > 3 && (
          <div className="relative z-10 w-5 h-5 rounded-[7px] bg-[#dcdce0] dark:bg-accent flex items-center justify-center ring-1 ring-background">
            <span className="text-[9.5px] font-mono font-medium text-gray-600 dark:text-muted-foreground">
              +{assignees.length - 3}
            </span>
          </div>
        )}
      </div>
      {assignees.length === 1 && (
        <span className="text-sm text-gray-600 dark:text-muted-foreground truncate ml-1.5">
          {assignees[0].name.split(' ')[0]}
        </span>
      )}
    </div>
  );
}

function TaskAssigneeTriggerContent({ task, projectMembers }: Readonly<{ task: Task; projectMembers: ProjectMember[] }>) {
  if (task.assignees && task.assignees.length > 0) {
    return <AssigneeStack assignees={task.assignees} projectMembers={projectMembers} />;
  }
  if (!task.assignee) return <span className="text-sm text-gray-400">—</span>;

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
}

type SortableRowStyleArgs = {
  isDragging: boolean;
  isSorting: boolean;
  isDragEnabled: boolean;
  activeIndex: number;
  overIndex: number;
  rectHeight: number | undefined;
  transform: Parameters<typeof CSS.Transform.toString>[0];
};

function getSortableRowStyle({
  isDragging,
  isSorting,
  isDragEnabled,
  activeIndex,
  overIndex,
  rectHeight,
  transform,
}: SortableRowStyleArgs): React.CSSProperties {
  // Only apply drag-related layout styles while a sort is in progress. When idle, leave
  // the row completely alone so there are no stray stacking contexts or transitions that
  // could flicker during normal hover.
  if (!isSorting) return { cursor: isDragEnabled ? 'grab' : undefined };

  // Dragged row snaps to the target slot. Non-dragged rows use dnd-kit's own shift
  // transform so they fill the gap the dragged row leaves behind. We override transition
  // for both so they share the exact same timing and never cross paths mid-animation.
  let snapY = 0;
  if (isDragging && rectHeight !== undefined && activeIndex !== -1) {
    const targetIndex = overIndex === -1 ? activeIndex : overIndex;
    snapY = (targetIndex - activeIndex) * rectHeight;
  }

  return {
    transform: isDragging ? `translate3d(0, ${snapY}px, 0)` : CSS.Transform.toString(transform),
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

  const style = getSortableRowStyle({
    isDragging,
    isSorting,
    isDragEnabled,
    activeIndex,
    overIndex,
    rectHeight: rect.current?.height,
    transform,
  });

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
}: Readonly<TasksClientProps>) {
  const { t } = useI18n();
  const { formatShort } = useDateLocale();
  const stageLabel = useStageLabel();
  // Entity mode: board is embedded inside a CRM panel scoped to a company/person.
  // Tasks span multiple projects; project-only features are suppressed.
  const isEntityMode = !!entityScope;
  // Only needed in entity mode, to pre-fill the "Add Task" dialog's assignee
  // the way the My Tasks dialog does (defaults to the current user).
  const { userId: currentUserId } = useAuth();
  // Entity mode has no project member list. Walk every cursor page of the
  // workspace directory only there; project boards keep using membersApi.list.
  const { data: workspaceMembersData } = useWorkspaceMemberDirectory(isEntityMode);

  const priorityConfig = useMemo(() => ({
    low: { label: t.projects.tasks.priorityLow, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    medium: { label: t.projects.tasks.priorityMedium, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    high: { label: t.projects.tasks.priorityHigh, color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
    urgent: { label: t.projects.tasks.priorityUrgent, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
    critical: { label: t.projects.tasks.priorityCritical, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  }), [t]);

  const statusConfig: Record<string, { label: string; icon: typeof Circle; color: string; bg: string }> = useMemo(() => ({
    backlog: { label: t.projects.tasks.statusBacklog, icon: Circle, color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-900/50' },
    todo: { label: t.projects.tasks.statusTodo, icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    in_progress: { label: t.projects.tasks.statusInProgress, icon: Clock, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    review: { label: t.projects.tasks.statusReview, icon: Clock, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
    in_review: { label: t.projects.tasks.statusInReview, icon: Clock, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
    testing: { label: t.projects.tasks.statusTesting, icon: Clock, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
    done: { label: t.projects.tasks.statusDone, icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
    cancelled: { label: t.projects.tasks.statusCancelled, icon: Circle, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  }), [t]);

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

  const initialFlattened = useMemo(() => flattenTaskTree(initialTasks.map((task) => transformApiTask(task))), [initialTasks]);
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
  const setSortState = useCallback((next: SortState | null | ((prev: SortState | null) => SortState | null)) => {
    if (isSortControlled) {
      const resolved = typeof next === 'function' ? (next as (prev: SortState | null) => SortState | null)(sortState) : next;
      onSortChange!(resolved);
    } else {
      setInternalSortState(next);
    }
  }, [isSortControlled, sortState, onSortChange]);
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
  const [loadedProjectMembers, setLoadedProjectMembers] = useState<ProjectMember[]>([]);
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
    // Intentionally keyed on the id, not the whole object — re-opening the panel
    // on every unrelated field edit (priority/status/etc. while the same task
    // stays selected) would reset the panel's own transient UI state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Drag-and-drop state
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );
  // Drag reorder is disabled in entity mode (tasks span multiple projects — there
  // is no single position sequence to persist) and whenever a sort is active.
  const isDragEnabled = !isEntityMode && canWrite && !sortState;

  const handleSaveSubtask = useCallback(async (data: {
    title: string;
    description?: string;
    status: CrmTask['status'];
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
    const effectiveProjectId = (isEntityMode ? selectedTask.projectId : null) ?? projectId;
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
      const subtaskData = result.data as RawApiTask;
      const newSubtask = transformApiTask(subtaskData);
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
  }, [isEntityMode, selectedTask, projectId, t.projects.tasks.failedToCreateSubtask, t.projects.tasks.subtaskCreated]);

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
      void tasksApi.listSubtasks(projectId, taskId).then((result) => {
        if (result.success && result.data && Array.isArray(result.data)) {
          const children = result.data;
          setInlineSubtasks((prev) =>
            prev[taskId]
              ? prev
              : { ...prev, [taskId]: children.map((child) => transformApiTask(child)) },
          );
        }
      });
    }
  }, [projectId]);

  // Fetch labels. In entity mode we fetch workspace-wide labels only (no projectId)
  // because tasks span multiple projects. In project mode we fetch project + workspace labels.
  useEffect(() => {
    async function loadLabels() {
      const result = isEntityMode ? await labelsApi.list() : await labelsApi.list(projectId);
      if (result.success && result.data) {
        setAvailableLabels(result.data);
      }
    }
    void loadLabels();
  }, [projectId, isEntityMode]);

  // Fetch this project's pipeline stages for the Create Task dialog.
  // In entity mode stages are per-project and meaningless cross-project; skip the
  // fetch and leave projectStages empty so the board falls back to status-based grouping.
  useEffect(() => {
    if (isEntityMode) return;
    async function loadStages() {
      const result = await stagesApi.list(projectId);
      if (result.success && Array.isArray(result.data)) {
        const stages = result.data as RawStage[];
        const sorted = [...stages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        setProjectStages(sorted.map((s) => ({
          id: s.id,
          name: s.name,
          color: s.color || '#94a3b8',
          systemStatus: s.systemStatus || s.id,
        })));
      }
    }
    void loadStages();
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
  }, [isEntityMode, projectId, t.projects.tasks.failedToCreateLabel]);

  // Live task sync: useRealtimeSync(platformSyncMap) invalidates project/task
  // query roots — no parallel useTaskEvents bridge (Phase 9 stub cleanup).

  // Fetch project members for the assignee dropdown. Entity mode has no single
  // project, so that board uses the workspace directory instead (see below).
  useEffect(() => {
    if (isEntityMode) return;
    async function loadMembers() {
      const result = await membersApi.list(projectId);
      if (result.success && result.data) {
        setLoadedProjectMembers(result.data);
      }
    }
    void loadMembers();
  }, [projectId, isEntityMode]);

  // Customer/person Tasks tab: every workspace member is selectable, including
  // on a customer that has no tasks yet. People already assigned who have left
  // the workspace stay in the list so their name still renders.
  const entityAssigneeDirectory = useMemo(
    () =>
      isEntityMode
        ? buildEntityAssigneeDirectory(workspaceMembersData?.data ?? [], tasks)
        : null,
    [isEntityMode, workspaceMembersData, tasks],
  );
  const projectMembers = entityAssigneeDirectory ?? loadedProjectMembers;

  const handleTaskDialogSave = async (data: {
    title: string;
    description?: string;
    status: string;
    priority?: 'low' | 'medium' | 'high';
    assigneeId?: string;
    assigneeIds?: string[];
    dueDate?: Date;
    duration?: number;
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
    // (In entity mode `projectStages` is never populated, so this is always a no-op there.)
    const pickedStage = projectStages.find(s => s.id === data.status);
    const resolvedStageId = pickedStage?.id;
    const resolvedStatus = pickedStage?.systemStatus ?? statusMap[data.status] ?? 'todo';

    const assigneeIds = data.assigneeIds || (data.assigneeId ? [data.assigneeId] : undefined);
    const repeat = data.repeat ? { frequency: data.repeat.frequency } : undefined;

    setIsCreatingTask(true);
    // Entity mode has no single project to create into — create via the global
    // /tasks endpoint instead, linked to the CRM company/person this panel is
    // scoped to (customerId / personId), same as My Tasks does for its tasks.
    const result = isEntityMode
      ? await tasksApi.createGlobal({
          title: data.title,
          description: data.description,
          status: resolvedStatus,
          priority: data.priority,
          assigneeIds,
          dueDate: data.dueDate?.toISOString(),
          // The dialog defaults the duration chip to 30m; dropping it here saved
          // `duration: null` for every task created from a company/person panel.
          duration: data.duration,
          labels: data.labels,
          repeat,
          customerId: entityScope!.kind === 'company' ? entityScope!.id : undefined,
          personId: entityScope!.kind === 'person' ? entityScope!.id : undefined,
        })
      : await tasksApi.create(projectId, {
          title: data.title,
          description: data.description,
          stageId: resolvedStageId,
          status: resolvedStatus,
          priority: data.priority,
          assigneeIds,
          dueDate: data.dueDate?.toISOString(),
          labels: data.labels,
          repeat,
        });
    setIsCreatingTask(false);

    if (result.success && result.data) {
      const newTask = transformApiTask(result.data as RawApiTask);
      setTasks(prev => [newTask, ...prev]);
      setShowAddDialog(false);
      toast.success(t.projects.tasks.taskCreated);
    } else {
      toast.error(result.error || t.projects.tasks.failedToCreateTask);
    }
  };

  // Fetch the follow-up occurrence of a recurring task and add it to the list.
  const prependNextRecurringTask = useCallback(async (nextTaskId: string) => {
    const nextResult = await tasksApi.get(projectId, nextTaskId);
    if (nextResult.success && nextResult.data) {
      const nextTask = transformApiTask(nextResult.data as RawApiTask);
      setTasks(prev => [nextTask, ...prev]);
      toast.success(t.projects.tasks.nextRecurringCreated);
    }
  }, [projectId, t.projects.tasks.nextRecurringCreated]);

  // The list groups by stageId first, so a status change has to move the stage
  // too. Mirrors the API: keep the stage when it already maps to the status,
  // else take the first stage for it.
  const stageIdForStatus = useCallback((task: Task, status: Task['status']) => {
    if (projectStages.find(s => s.id === task.stageId)?.systemStatus === status) return task.stageId;
    return projectStages.find(s => s.systemStatus === status)?.id ?? task.stageId;
  }, [projectStages]);

  const handleCheckboxToggle = useCallback(async (taskId: string, currentStatus: Task['status']) => {
    if (!canWrite) return;

    // Look for the task in the main list first, then in any expanded parent's
    // inlineSubtasks (subtasks may only exist there).
    const { task, subtaskParentId } = findTaskWithParent(tasks, inlineSubtasks, taskId);
    if (!task) return;

    // Helper to patch both `tasks` and any matching entry in `inlineSubtasks`.
    // The stage follows the status unless one is given (rollback).
    const patchTaskStatus = (newStatus: Task['status'], stageId = stageIdForStatus(task, newStatus)) => {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus, stageId } : t));
      if (subtaskParentId) {
        setInlineSubtasks(prev => {
          const subs = prev[subtaskParentId!];
          if (!subs) return prev;
          return {
            ...prev,
            [subtaskParentId!]: subs.map(s => s.id === taskId ? { ...s, status: newStatus, stageId } : s),
          };
        });
      }
    };

    // Going from done → todo: toggle immediately without animation
    if (currentStatus === 'done') {
      patchTaskStatus('todo');
      void tasksApi.toggle(projectId, taskId, 'done').then((result) => {
        if (!result.success) {
          patchTaskStatus('done', task.stageId);
          toast.error(t.projects.tasks.failedToUpdateTask);
        }
      });
      return;
    }

    // A parent can't be completed while subtasks are still open. Say so instead
    // of ticking a box that is never saved. Prefer the loaded subtask rows
    // (they follow local edits); fall back to the server counts for a
    // collapsed parent whose subtasks haven't been fetched yet.
    const loadedSubtasks = inlineSubtasks[task.id];
    const openSubtaskCount = loadedSubtasks && loadedSubtasks.length > 0
      ? loadedSubtasks.filter(s => s.status !== 'done' && s.status !== 'cancelled').length
      : Math.max(0, (task.subtaskCount ?? 0) - (task.completedSubtaskCount ?? 0));
    if (openSubtaskCount > 0) {
      toast.error(t.projects.tasks.completeSubtasksFirst);
      return;
    }

    // If this is a subtask, persist immediately (no flash animation).
    if (subtaskParentId) {
      patchTaskStatus('done');
      void tasksApi.toggle(projectId, taskId, task.status).then((result) => {
        if (!result.success) {
          patchTaskStatus(task!.status, task!.stageId);
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
          ? { ...t, status: 'done' as Task['status'], stageId: stageIdForStatus(t, 'done') }
          : t
        ));
      } else {
        toast.error(result.error || t.projects.tasks.failedToUpdateTask);
      }

      setCompletingTaskIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    };

    runInViewTransition(commit);

    // Fetch the next recurring task (if any) after the view transition kicks off —
    // its arrival in the list will naturally re-render without blocking the animation.
    if (result.success && result.data?.nextTaskId) {
      await prependNextRecurringTask(result.data.nextTaskId);
    }
  }, [canWrite, tasks, projectId, inlineSubtasks, prependNextRecurringTask, stageIdForStatus, t.projects.tasks.failedToUpdateTask, t.projects.tasks.completeSubtasksFirst]);

  const deleteTask = useCallback((taskId: string) => {
    // The task may be a subtask that only lives in inlineSubtasks; resolve it
    // there too so its parent's counts can follow the delete.
    const { task, subtaskParentId } = findTaskWithParent(tasks, inlineSubtasks, taskId);
    const parentId = subtaskParentId ?? task?.parentTaskId ?? null;
    const wasDone = task?.status === 'done';
    const removedIds = collectSubtreeIds(tasks, inlineSubtasks, taskId);

    startTransition(async () => {
      const result = await tasksApi.delete(projectId, taskId);

      if (result.success) {
        // The API deletes the whole subtree. Drop it from both lists and take
        // the task off its parent's counts — the parent may be a top-level row
        // or itself an inline subtask.
        const shrinkParent = (row: Task): Task => row.id === parentId
          ? {
              ...row,
              subtaskCount: Math.max(0, (row.subtaskCount ?? 0) - 1),
              completedSubtaskCount: Math.max(0, (row.completedSubtaskCount ?? 0) - (wasDone ? 1 : 0)),
            }
          : row;
        setTasks(prev => prev.filter((row) => !removedIds.has(row.id)).map(shrinkParent));
        setInlineSubtasks(prev => {
          const next: Record<string, Task[]> = {};
          for (const [pid, subs] of Object.entries(prev)) {
            if (removedIds.has(pid)) continue;
            next[pid] = subs.filter((row) => !removedIds.has(row.id)).map(shrinkParent);
          }
          return next;
        });
        toast.success(t.projects.tasks.taskDeleted);
      } else {
        toast.error(result.error || t.projects.tasks.failedToDeleteTask);
      }
    });
  }, [tasks, inlineSubtasks, projectId, startTransition, t.projects.tasks.failedToDeleteTask, t.projects.tasks.taskDeleted]);

  const formatDateShort = useCallback((date: Date | string) => formatShort(date), [formatShort]);

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

    const result = await persistStageChange(projectId, taskId, stage.id, oldStatus, newStatus);

    if (result.success) {
      if (result.data?.nextTaskId) {
        await prependNextRecurringTask(result.data.nextTaskId);
      }
    } else {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: oldStatus, stageId: oldStageId } : t));
      toast.error(t.projects.tasks.failedToUpdateTask);
    }
  }, [tasks, projectId, projectStages, prependNextRecurringTask, t.projects.tasks.failedToUpdateTask]);

  const updateTaskInline = useCallback(async (taskId: string, data: Partial<Task>) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...data } : t));
    setSelectedTask(prev => prev?.id === taskId ? { ...prev, ...data } : prev);

    const apiData: Record<string, unknown> = { ...data };
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
  }, [projectId, t.projects.tasks.failedToUpdateTask]);

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
  }, [isEntityMode, topLevelTasks, projectId, t.projects.tasks.failedToReorderTasks]);

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
      ],
    },
    {
      field: 'label',
      label: t.projects.tasks.filterLabel,
      options: availableLabels.map(l => ({ value: l.id, label: l.name })),
    },
    {
      field: 'assignee',
      label: t.projects.tasks.filterAssignee,
      searchable: true,
      options: projectMembers
        .filter(m => m.user?.name)
        .map(m => ({ value: m.userId, label: m.user!.name })),
    },
    {
      field: 'dueDate',
      label: t.projects.tasks.filterDueDate,
      options: [
        { value: 'overdue', label: t.projects.tasks.groupOverdue },
        { value: 'today', label: t.projects.tasks.groupToday },
        { value: 'this-week', label: t.projects.tasks.groupThisWeek },
        { value: 'later', label: t.projects.tasks.groupLater },
        { value: 'no-date', label: t.projects.tasks.groupNoDate },
      ],
    },
  ], [availableLabels, projectMembers, t]);

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
          filter: (t: Task) => getTaskAssigneeIds(t).includes(m.userId),
        };
      });
      memberGroups.push({
        id: 'unassigned',
        label: t.projects.tasks.groupUnassigned,
        sortOrder: projectMembers.length + 1,
        filter: (t) => getTaskAssigneeIds(t).length === 0,
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
      label: stageLabel(stage.name, stage.systemStatus),
      sortOrder: i + 1,
      filter: (t: Task) => {
        const s = getTaskStage(t);
        return s?.id === stage.id;
      },
    }));
  }, [groupBy, projectStages, getTaskStage, projectMembers, t, stageLabel]);

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
          ? result.filter(t => Array.isArray(t.labels) && t.labels.includes(filter.value))
          : result.filter(t => !Array.isArray(t.labels) || !t.labels.includes(filter.value));
      } else if (filter.field === 'assignee') {
        result = filter.operator === 'is'
          ? result.filter(t => getTaskAssigneeIds(t).includes(filter.value))
          : result.filter(t => !getTaskAssigneeIds(t).includes(filter.value));
      } else if (filter.field === 'dueDate') {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const startOfTomorrow = new Date(startOfToday);
        startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
        const startOfNextWeek = new Date(startOfToday);
        startOfNextWeek.setDate(startOfNextWeek.getDate() + 7);
        const inBucket = (t: Task): boolean => {
          const due = t.dueDate;
          switch (filter.value) {
            case 'overdue': return !!due && due < startOfToday;
            case 'today': return !!due && due >= startOfToday && due < startOfTomorrow;
            case 'this-week': return !!due && due >= startOfTomorrow && due < startOfNextWeek;
            case 'later': return !!due && due >= startOfNextWeek;
            case 'no-date': return !due;
            default: return true;
          }
        };
        result = filter.operator === 'is' ? result.filter(inBucket) : result.filter(t => !inBucket(t));
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
  }, [setSortState]);

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
      return STATUS_SORT_ORDER.indexOf(t.status);
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
          cmp = (PRIORITY_SORT_ORDER.indexOf(a.priority) - PRIORITY_SORT_ORDER.indexOf(b.priority)) * dir;
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
  }, [sortState, topLevelTasks, getTaskStage, projectStages]);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'checkbox', header: t.projects.tasks.headerTask, width: 'w-4 flex-shrink-0' },
    { id: 'task', header: '', width: cn('min-w-[200px] flex-1', isEntityMode && ENTITY_NARROW_TITLE) },
    { id: 'status', header: t.projects.tasks.headerStatus, width: cn('w-[120px]', isEntityMode && ENTITY_HIDE_WHEN_COMPACT), sortable: true },
    { id: 'priority', header: t.projects.tasks.headerPriority, width: cn('w-[100px]', isEntityMode && ENTITY_NARROW_PRIORITY), sortable: true },
    { id: 'dueDate', header: t.projects.tasks.headerDue, width: cn('w-[100px]', isEntityMode && ENTITY_NARROW_DUE), sortable: true },
    { id: 'assignee', header: t.projects.tasks.headerAssignee, width: cn('w-[120px]', isEntityMode && ENTITY_HIDE_WHEN_NARROW), sortable: true },
  ], [t, isEntityMode]);

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
    const isVisuallyDone = task.status === 'done';

    return (
      <div
        key={task.id}
        className={cn(
          // Phones: let the metadata columns wrap under the title instead of
          // running past the viewport edge (the list container clips overflow).
          "relative flex items-center gap-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer group max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1.5",
          isEntityMode && ENTITY_NARROW_GAP,
          !isSubtask && "border-b border-gray-200/70 dark:border-border",
          isVisuallyDone && !isCompleting && "opacity-50",
          isCompleting && "task-completing-inner"
        )}
        style={{ paddingLeft: isSubtask ? 48 + depth * 32 : 16, paddingRight: 16 }}
      >
        {/* Row click target: stretched button; interactive cells sit above it */}
        <button
          type="button"
          aria-label={task.title}
          onClick={() => {
            setSelectedTask(task);
            // Open directly as well: the selection effect is keyed on the id, so
            // it would not fire again for a task that is still "selected" after
            // its panel was closed.
            openTaskPanel({ type: 'task', id: task.id });
          }}
          className="absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        {/* Checkbox */}
        <div className="relative z-[1] flex-shrink-0 translate-y-[1px]">
          <Checkbox
            checked={isVisuallyDone || isCompleting}
            onCheckedChange={() => handleCheckboxToggle(task.id, task.status)}
            disabled={isPending || !canWrite || isCompleting}
            className="h-4 w-4"
          />
        </div>

        {/* Task Title */}
        <div className={cn("min-w-[200px] flex-1 flex items-center gap-2 max-md:min-w-0 max-md:basis-[calc(100%-2rem)]", isEntityMode && ENTITY_NARROW_TITLE)}>
          {task.number != null && (
            <TaskNumberBadge number={task.number} className="h-[18px] flex-shrink-0 py-0" />
          )}
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
              className="relative z-[1] p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-gray-200 dark:hover:bg-gray-700 transition-[opacity,color,background-color] flex-shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
              {repeatBadgeLabel(task.repeat)}
            </span>
          )}
          {((task.dependsOn?.length ?? 0) > 0 || (task.blocks?.length ?? 0) > 0) && (
            <div className="flex items-center flex-shrink-0 text-gray-400 dark:text-muted-foreground">
              <Link className="h-3 w-3" />
            </div>
          )}
        </div>

        {/* Attachments & Subtask count */}
        <div className={cn("w-[60px] flex justify-end gap-1 max-md:w-auto max-md:empty:hidden", isEntityMode && ENTITY_HIDE_WHEN_COMPACT)}>
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
        <div className={cn("relative z-[1] w-[120px] max-md:w-auto", isEntityMode && ENTITY_HIDE_WHEN_COMPACT)}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn("-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow", statusFallback.color, statusFallback.bg)}>
                {stage ? stageLabel(stage.name, stage.systemStatus) : statusFallback.label}
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
                      <span>{stageLabel(s.name, s.systemStatus)}</span>
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
        <div className={cn("relative z-[1] w-[100px] max-md:w-auto", isEntityMode && ENTITY_NARROW_PRIORITY)}>
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
        <div className={cn("relative z-[1] w-[100px] max-md:w-auto", isEntityMode && ENTITY_NARROW_DUE)}>
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
                    <span>{t.projects.tasks.clearDate}</span>
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Assignee(s) */}
        <div className={cn("relative z-[1] w-[120px] max-md:w-auto", isEntityMode && ENTITY_HIDE_WHEN_NARROW)}>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  'h-auto cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded-[6px] pl-0.5 py-0.5 transition-shadow',
                  // When multiple avatars are stacked (no name shown), match the left-side padding
                  task.assignees && task.assignees.length > 1 ? 'pr-0.5' : 'pr-1.5',
                )}
              >
                <TaskAssigneeTriggerContent task={task} projectMembers={projectMembers} />
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
                      void updateTaskInline(task.id, {
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
        <div className={cn("relative z-[1] w-[40px] flex justify-end", isEntityMode && ENTITY_NARROW_ACTIONS)}>
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
                    const dupProjectId = (isEntityMode ? task.projectId : null) ?? projectId;
                    const result = await tasksApi.create(dupProjectId, {
                      title: `${task.title} (copy)`,
                      description: task.description,
                      status: task.status,
                      priority: task.priority,
                    });
                    if (result.success && result.data) {
                      const duplicatedTask = transformApiTask(result.data as RawApiTask);
                      setTasks(prev => [duplicatedTask, ...prev]);
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
  }, [isPending, canWrite, deleteTask, availableLabels, expandedTaskIds, toggleExpandTask, handleStageChange, getTaskStage, projectStages, updateTaskInline, projectMembers, formatDateShort, startTransition, projectId, completingTaskIds, handleCheckboxToggle, showMoveTask, t, availableCompanies, isEntityMode, priorityConfig, statusConfig, openTaskPanel, stageLabel]);

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
  const renderRow = useCallback((task: Task) => {
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
          <EntityContainerScope enabled={isEntityMode}>
          <EntityList<Task>
            items={sortedTasks}
            isLoading={false}
            error={null}
            headerColumns={headerColumns}
            columnGap={isEntityMode ? `gap-4 ${ENTITY_NARROW_GAP}` : undefined}
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
            // A panel's task list sits in a short, scrolling box: a viewport-sized,
            // vertically centred empty state pushed its text below the fold and
            // left only the illustration on screen.
            emptyStateClassName={isEntityMode ? 'min-h-0 py-10' : 'min-h-[calc(100dvh-350px)]'}
        createButton={canWrite ? {
          label: t.projects.tasks.addTaskBtn,
          // Both modes open the task dialog. In entity mode the dialog shows a
          // project picker (`availableProjects`) and the entity link is injected
          // on save — see handleTaskDialogSave.
          onClick: () => setShowAddDialog(true),
        } : undefined}
        emptyState={{
          // The 240x170 illustration is for the full-page board; in a panel it
          // takes the whole visible height and the text never shows.
          icon: isEntityMode ? (
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center mb-3">
              <ListTodo className="h-5 w-5 text-muted-foreground" />
            </div>
          ) : (
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
        noResultsState={searchQueryProp?.trim() ? {
          title: t.projects.tasks.noTasksMatchTitle,
          description: t.projects.tasks.noTasksMatchSearchDesc.replace('{query}', searchQueryProp.trim()),
        } : {
          title: t.projects.tasks.noTasksMatchTitle,
          description: t.projects.tasks.noResultsDesc,
        }}
      />
          </EntityContainerScope>
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
        availableStatuses={projectStages.map(s => ({ id: s.id, label: stageLabel(s.name, s.systemStatus), color: s.color }))}
        onCreateLabel={handleCreateLabel}
        hideRecord
        defaultAssignee={isEntityMode ? currentUserId ?? undefined : undefined}
        onSave={handleTaskDialogSave}
        projectId={projectId}
        onUpdate={(taskId, data) => {
          const projectData: Record<string, unknown> = {};
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
          // Only a changed duration is sent: the dialog echoes the current value
          // back on every save, and a write re-plans the task's calendar block.
          if (data.duration !== undefined && data.duration !== editingCrmTask?.duration) {
            projectData.duration = data.duration;
          }
          if (data.labels !== undefined) projectData.labels = data.labels;
          if (data.repeat !== undefined) projectData.repeat = data.repeat;

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
        availableStatuses={projectStages.map(s => ({ id: s.id, label: stageLabel(s.name, s.systemStatus), color: s.color }))}
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
