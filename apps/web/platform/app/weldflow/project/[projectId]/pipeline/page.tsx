
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type Collision,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@weldsuite/ui/components/button';
import {
  Plus,
  Pencil,
  Trash2,
  Copy,
  ArrowLeft,
  ArrowRight,
  Calendar,
  CalendarClock,
  MessageSquare,
  Paperclip,
  Search,
  Hash,
  Clock,
  Flag,
  Tag,
  UserCheck,
  UserX,
  Minus,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { toast } from 'sonner';
import { TASK_DELETED_EVENT } from '@/components/objects/task/use-task-data';
import { tasksApi, membersApi, stagesApi, labelsApi } from '@/app/weldflow/lib/api-client';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@/lib/utils';
import { LabelOverflowList } from '@/app/weldflow/lib/label-overflow-list';
import { TaskNumberBadge } from '@/components/weldflow/task-number-badge';
import { taskNumberMatches } from '@/lib/task-number';
import { useObjectPanel } from '@/components/object-panel';
import { useProjectLabels } from '@/app/weldflow/hooks/use-project-labels';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { FilterPills } from '@/components/entity-list';
import type { FilterConfig, ActiveFilter } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';
import { formatShortDateNow } from '@/lib/i18n/date-locale';
import { useStageLabel } from '../../../lib/stage-labels';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { buildStatusToStageId } from '@/app/weldflow/lib/stage-resolution';
import { persistStageChange } from '@/app/weldflow/lib/persist-stage-change';

// ---------- Types ----------

interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

interface TaskFeature {
  id: string;
  name: string;
  description?: string;
  column: string;
  startAt: Date;
  endAt: Date;
  hasStartDate?: boolean;
  hasDueDate?: boolean;
  duration?: number;
  estimatedHours?: number;
  owner?: { id: string; name: string; image?: string };
  owners?: { id: string; name: string; image?: string }[];
  priority?: string;
  /** Workspace-wide sequential number, rendered as the bare number. */
  number?: number | null;
  taskKey?: string;
  commentsCount?: number;
  attachmentsCount?: number;
  labels?: string[];
}

function formatDuration(minutes: number): string {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

interface StageColumn {
  id: string;
  name: string;
  color: string;
  systemStatus: string;
}

// Raw stage shape as returned by the app-api project-pipeline-stages endpoint
interface RawPipelineStage {
  id: string;
  name?: string;
  color?: string;
  systemStatus?: string;
}

interface ProjectMember {
  id: string;
  userId: string;
  role: string;
  user?: {
    id: string;
    name: string;
    email: string;
  };
}

// ---------- Constants ----------

const stageColors = [
  '#94a3b8', '#c4b5fd', '#93c5fd', '#fcd34d', '#fdba74', '#5eead4',
  '#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fb923c', '#f87171',
];

// ---------- Helpers ----------

// Raw task shape as returned by the app-api tasks endpoints
interface RawPipelineTask {
  id: string;
  /** Workspace-wide sequential number, displayed as the bare number. */
  number?: number | null;
  title?: string;
  description?: string;
  startDate?: string | null;
  dueDate?: string | null;
  duration?: number | null;
  estimatedHours?: number | null;
  stageId?: string | null;
  status?: string;
  priority?: string;
  key?: string;
  commentsCount?: number;
  attachmentsCount?: number;
  _count?: { comments?: number; attachments?: number };
  labels?: string[];
  assigneeId?: string;
  assigneeName?: string;
  assignee?: { id?: string; name?: string; avatar?: string; image?: string } | null;
  assignees?: { id: string; name: string; avatar?: string; image?: string }[];
}

/** Translated fallbacks for a task without a title / an assignee without a name. */
interface FeatureFallbacks {
  untitled: string;
  unknown: string;
}

function mapTaskToFeature(
  task: RawPipelineTask,
  statusToStageId: Map<string, string> | undefined,
  fallbacks: FeatureFallbacks,
): TaskFeature {
  const startDate = task.startDate ? new Date(task.startDate) : new Date();
  const endDate = task.dueDate ? new Date(task.dueDate) : new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

  const resolvedColumn =
    (task.stageId && statusToStageId?.get(task.stageId)) ||
    (task.status && statusToStageId?.get(task.status)) ||
    task.stageId ||
    task.status ||
    'todo';

  return {
    id: task.id,
    name: task.title || fallbacks.untitled,
    description: task.description,
    startAt: startDate,
    endAt: endDate,
    hasStartDate: !!task.startDate,
    hasDueDate: !!task.dueDate,
    duration: task.duration ?? undefined,
    estimatedHours: task.estimatedHours ?? undefined,
    column: resolvedColumn,
    owner: task.assignee ? {
      id: task.assignee.id || task.assigneeId || '',
      name: task.assignee.name || task.assigneeName || fallbacks.unknown,
      image: task.assignee.avatar || task.assignee.image,
    } : undefined,
    owners: Array.isArray(task.assignees) && task.assignees.length > 0
      ? task.assignees.map((a) => ({ id: a.id, name: a.name, image: a.avatar || a.image }))
      : undefined,
    priority: task.priority,
    number: task.number ?? null,
    taskKey: task.key,
    commentsCount: task.commentsCount || task._count?.comments || 0,
    attachmentsCount: task.attachmentsCount || task._count?.attachments || 0,
    labels: task.labels || undefined,
  };
}


// ---------- DroppableStage ----------

function DroppableStage({ id, children, containerRef }: Readonly<{ id: string; children: React.ReactNode; containerRef?: React.RefObject<HTMLDivElement | null> }>) {
  const { isOver, setNodeRef } = useDroppable({ id: `stage-${id}` });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [overlayStyle, setOverlayStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (isOver && stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      const containerBottom = containerRef?.current ? containerRef.current.getBoundingClientRect().bottom : undefined;
      setOverlayStyle({
        position: 'fixed',
        top: rect.top - 16,
        left: rect.left - 8,
        width: rect.width + 16,
        bottom: containerBottom !== undefined ? window.innerHeight - containerBottom : 0,
        borderRadius: 0,
      });
    }
  }, [isOver, containerRef]);

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        stageRef.current = node;
      }}
      className={cn(
        "group flex flex-col w-full h-full rounded-t-lg rounded-b-md relative transition-colors duration-200",
        isOver && "!rounded-none"
      )}
    >
      {isOver && <div className="!bg-blue-100 dark:!bg-blue-300 pointer-events-none z-10" style={overlayStyle} />}
      <div className="relative z-20">{children}</div>
    </div>
  );
}

// ---------- SortableStage ----------

function SortableStage({ id, disabled, children }: Readonly<{ id: string; disabled?: boolean; children: React.ReactNode }>) {
  const { setNodeRef, transform, transition, isDragging } = useSortable({
    id: `sortable-stage-${id}`,
    data: { type: 'stage', stageId: id },
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("flex-shrink-0 w-[240px] relative overflow-visible", isDragging && "opacity-50 z-50")}
    >
      {children}
    </div>
  );
}

// ---------- TaskCard ----------

function TaskCard({ feature, isDragging, onClick, availableLabels = [], canWrite = false }: Readonly<{ feature: TaskFeature; isDragging?: boolean; onClick?: () => void; availableLabels?: ProjectLabel[]; canWrite?: boolean }>) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging: isSortableDragging } = useSortable({ id: feature.id, disabled: !canWrite });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isSortableDragging ? undefined : (transition || 'transform 200ms cubic-bezier(0.18, 0.67, 0.6, 1.22)'),
  };

  const hasDragged = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    hasDragged.current = false;
    startPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const dx = Math.abs(e.clientX - startPos.current.x);
    const dy = Math.abs(e.clientY - startPos.current.y);
    if (dx > 5 || dy > 5) hasDragged.current = true;
  };

  const handleClick = (e: React.MouseEvent) => {
    if (!hasDragged.current && onClick && !isSortableDragging) {
      e.stopPropagation();
      onClick();
    }
  };

  const priorityConfig: Record<string, { label: string; color: string; bg: string }> = {
    low: { label: t.projects.pipeline.priorityLow, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    medium: { label: t.projects.pipeline.priorityMedium, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    high: { label: t.projects.pipeline.priorityHigh, color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
    urgent: { label: t.projects.pipeline.priorityUrgent, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
    critical: { label: t.projects.pipeline.priorityCritical, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  };

  const cardContent = (
    <>
      {/* Task number */}
      {feature.number != null && (
        <TaskNumberBadge number={feature.number} className="mb-1" />
      )}

      {/* Title */}
      <span className="font-medium text-gray-900 dark:text-foreground truncate block" style={{ fontSize: '15px' }}>
        {feature.name}
      </span>

      {/* Task Key */}
      {feature.taskKey && (
        <div className="flex items-center gap-2 mt-2">
          <Hash className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">{feature.taskKey}</span>
        </div>
      )}

      {/* Assignee */}
      <div className="flex items-center gap-2 mt-2">
        <Avatar className="h-4 w-4 rounded-[5px]">
          {feature.owner ? (
            <>
              <AvatarImage src={feature.owner.image} className="rounded-[5px]" />
              <AvatarFallback className="text-[9px] bg-cyan-500 text-white rounded-[5px]">
                {feature.owner.name.charAt(0).toUpperCase()}
              </AvatarFallback>
            </>
          ) : (
            <AvatarFallback className="text-[9px] bg-gray-100 text-gray-400 dark:bg-secondary dark:text-muted-foreground rounded-[5px]">
              ?
            </AvatarFallback>
          )}
        </Avatar>
        <span className="text-sm text-gray-600 dark:text-muted-foreground truncate">
          {feature.owner?.name || t.projects.pipeline.unassigned}
        </span>
      </div>

      {/* Priority */}
      {feature.priority && priorityConfig[feature.priority] && (
        <div className="flex items-center gap-2 mt-2.5">
          <Flag className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className={cn("px-2 py-0.5 rounded text-[12px] font-medium", priorityConfig[feature.priority].color, priorityConfig[feature.priority].bg)}>
            {priorityConfig[feature.priority].label}
          </span>
        </div>
      )}

      {/* Start Date */}
      {feature.hasStartDate && (
        <div className="flex items-center gap-2 mt-2.5">
          <CalendarClock className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {formatShortDateNow(feature.startAt)}
          </span>
        </div>
      )}

      {/* Due Date */}
      {feature.hasDueDate && (
        <div className="flex items-center gap-2 mt-2.5">
          <Calendar className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {formatShortDateNow(feature.endAt)}
          </span>
        </div>
      )}

      {/* Duration / estimated hours */}
      {(feature.duration != null || feature.estimatedHours != null) && (
        <div className="flex items-center gap-2 mt-2.5">
          <Clock className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {feature.duration != null
              ? formatDuration(feature.duration)
              : `${feature.estimatedHours}h`}
          </span>
        </div>
      )}

      {/* Labels */}
      {feature.labels && feature.labels.length > 0 && (
        <div className="flex items-center gap-2 mt-3">
          <Tag className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <LabelOverflowList
            labels={feature.labels
              .map((labelId) => availableLabels.find((l) => l.id === labelId))
              .filter((l): l is NonNullable<typeof l> => !!l)
              .map((l) => ({ id: l.id, name: l.name, color: l.color }))}
          />
        </div>
      )}

      {/* Footer: comments, attachments */}
      {((feature.commentsCount ?? 0) > 0 || (feature.attachmentsCount ?? 0) > 0) && (
        <div className="flex items-center gap-3 text-gray-400 mt-2.5">
          {(feature.commentsCount ?? 0) > 0 && (
            <div className="flex items-center gap-1 text-xs">
              <MessageSquare className="h-3 w-3" />
              <span>{feature.commentsCount}</span>
            </div>
          )}
          {(feature.attachmentsCount ?? 0) > 0 && (
            <div className="flex items-center gap-1 text-xs">
              <Paperclip className="h-3 w-3" />
              <span>{feature.attachmentsCount}</span>
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      className={cn(
        "group relative bg-white dark:bg-background rounded-lg border border-gray-125 dark:border-border text-left",
        "hover:bg-gray-50 dark:hover:bg-secondary/70 w-full",
        canWrite && "cursor-grab active:cursor-grabbing",
        "p-3 transition-all duration-200",
        isSortableDragging && "!bg-gray-100 dark:!bg-gray-800 !border-transparent",
        (isDragging || isSortableDragging) && "opacity-50",
        onClick && "cursor-pointer"
      )}
    >
      {isSortableDragging ? <div className="invisible">{cardContent}</div> : cardContent}
    </button>
  );
}

// ---------- StageHeader ----------

function PipelineStageHeader({ stage, taskCount, canWrite, onAddTask, onEditStage, onDeleteStage, onDuplicateStage, onMoveLeft, onMoveRight, isFirst, isLast }: Readonly<{
  stage: StageColumn;
  taskCount: number;
  canWrite: boolean;
  onAddTask: () => void;
  onEditStage: () => void;
  onDeleteStage: () => void;
  onDuplicateStage: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  isFirst: boolean;
  isLast: boolean;
}>) {
  const { t } = useI18n();
  const stageLabel = useStageLabel();
  const [isOpen, setIsOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const [dropdownWidth, setDropdownWidth] = useState(0);

  useEffect(() => {
    if (headerRef.current) setDropdownWidth(headerRef.current.offsetWidth);
  }, [isOpen]);

  return (
    <div className="mb-0">
      <div
        ref={headerRef}
        className={cn(
          "flex items-center justify-between mb-1 rounded-md px-1 py-1 -mx-1 transition-colors group",
          isOpen ? "bg-gray-100 dark:bg-secondary" : "hover:bg-gray-100 dark:hover:bg-secondary"
        )}
      >
        {canWrite ? (
          <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center gap-2 ml-1 h-auto p-0">
                <div className="w-3 h-3 rounded" style={{ backgroundColor: stage.color }} />
                <h3 className="font-medium text-sm text-gray-900 dark:text-foreground">{stageLabel(stage.name, stage.systemStatus)}</h3>
                <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px]">
                  {taskCount}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="bottom"
              sideOffset={4}
              alignOffset={-8}
              style={{ width: dropdownWidth > 0 ? `${dropdownWidth}px` : undefined }}
            >
              <DropdownMenuItem onClick={onEditStage}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.projects.pipeline.editStage}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicateStage}>
                <Copy className="h-4 w-4 mr-0.5" />
                {t.projects.pipeline.duplicateStage}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onMoveLeft} disabled={isFirst}>
                <ArrowLeft className="h-4 w-4 mr-0.5" />
                {t.projects.pipeline.moveLeft}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onMoveRight} disabled={isLast}>
                <ArrowRight className="h-4 w-4 mr-0.5" />
                {t.projects.pipeline.moveRight}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDeleteStage} className="text-red-600 dark:text-red-400 focus:bg-red-50 dark:focus:bg-red-950/40 focus:text-red-600 dark:focus:text-red-400">
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                {t.projects.pipeline.deleteStage}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="flex items-center gap-2 ml-1">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: stage.color }} />
            <h3 className="font-medium text-sm text-gray-900 dark:text-foreground">{stageLabel(stage.name, stage.systemStatus)}</h3>
            <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px]">
              {taskCount}
            </span>
          </div>
        )}
        {canWrite && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:bg-gray-200 dark:hover:bg-accent"
            onClick={onAddTask}
          >
            <Plus className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- Pipeline helpers ----------

const STAGE_SORTABLE_PREFIX = 'sortable-stage-';
const STAGE_DROP_PREFIX = 'stage-';

function matchesEqualityFilter(operator: string, actual: string, expected: string): boolean {
  return operator === 'is' ? actual === expected : actual !== expected;
}

function matchesAssigneeFilter(feature: TaskFeature, filter: ActiveFilter): boolean {
  if (filter.value === '__unassigned__') {
    return filter.operator === 'is' ? !feature.owner : !!feature.owner;
  }
  const name = (feature.owner?.name || '').toLowerCase();
  return matchesEqualityFilter(filter.operator, name, filter.value.toLowerCase());
}

function matchesDueFilter(feature: TaskFeature, filter: ActiveFilter): boolean {
  const dueDate = feature.endAt.toISOString().split('T')[0];
  if (filter.operator === 'is') return dueDate === filter.value;
  if (filter.operator === 'before') return dueDate < filter.value;
  if (filter.operator === 'after') return dueDate > filter.value;
  return true;
}

function featureMatchesFilter(feature: TaskFeature, filter: ActiveFilter): boolean {
  if (!filter.operator || !filter.value) return true;

  switch (filter.field) {
    case 'stage':
      return matchesEqualityFilter(filter.operator, feature.column, filter.value);
    case 'priority':
      return matchesEqualityFilter(filter.operator, (feature.priority || '').toLowerCase(), filter.value.toLowerCase());
    case 'assignee':
      return matchesAssigneeFilter(feature, filter);
    case 'due':
      return matchesDueFilter(feature, filter);
    default:
      return true;
  }
}

/** Stage id a stage-reorder drag was dropped on. */
function resolveStageDropId(overId: string): string {
  if (overId.startsWith(STAGE_SORTABLE_PREFIX)) return overId.replace(STAGE_SORTABLE_PREFIX, '');
  if (overId.startsWith(STAGE_DROP_PREFIX)) return overId.replace(STAGE_DROP_PREFIX, '');
  return overId;
}

/** Stage id a task drag was dropped on (a stage itself, or the stage of the task dropped on). */
function resolveTaskDropStageId(overId: string, features: TaskFeature[]): string | undefined {
  if (overId.startsWith(STAGE_DROP_PREFIX)) return overId.replace(STAGE_DROP_PREFIX, '');
  if (overId.startsWith(STAGE_SORTABLE_PREFIX)) return overId.replace(STAGE_SORTABLE_PREFIX, '');
  return features.find(f => f.id === overId)?.column;
}

/** Move stage `fromId` to the position of `toId`; null when either is missing. */
function reorderStages(stages: StageColumn[], fromId: string, toId: string): StageColumn[] | null {
  const oldIdx = stages.findIndex(s => s.id === fromId);
  const newIdx = stages.findIndex(s => s.id === toId);
  if (oldIdx === -1 || newIdx === -1) return null;
  const next = [...stages];
  const [moved] = next.splice(oldIdx, 1);
  next.splice(newIdx, 0, moved);
  return next;
}

// ---------- Main Pipeline Component ----------

const PipelinePage = () => {
  const params = useParams();
  const projectId = params.projectId as string;
  const { t } = useI18n();
  const stageLabel = useStageLabel();
  const { canWrite } = useProjectPermissions();
  const featureFallbacks = useMemo<FeatureFallbacks>(
    () => ({ untitled: t.projects.pipeline.untitledTask, unknown: t.common.labels.unknown }),
    [t],
  );

  const [features, setFeatures] = useState<TaskFeature[]>([]);
  const [columns, setColumns] = useState<StageColumn[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null);
  const [editingCrmTask, setEditingCrmTask] = useState<CrmTask | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [availableLabels, setAvailableLabels] = useProjectLabels(projectId);

  const handleCreateLabel = useCallback(async (data: { name: string; color: string }): Promise<ProjectLabel | null> => {
    if (!canWrite) return null;
    const result = await labelsApi.create({ ...data, projectId });
    if (result.success && result.data) {
      const newLabel: ProjectLabel = { id: result.data.id, name: data.name, color: data.color };
      setAvailableLabels(prev => [newLabel, ...prev]);
      return newLabel;
    }
    toast.error(t.projects.pipeline.labelCreateFailed);
    return null;
  }, [canWrite, projectId, t]);

  // Edit stage state
  const [showEditStageDialog, setShowEditStageDialog] = useState(false);
  const [editingStage, setEditingStage] = useState<StageColumn | null>(null);
  const [editStageName, setEditStageName] = useState('');
  const [editStageColor, setEditStageColor] = useState('');

  // Calculation type per column
  const [columnCalculations, setColumnCalculations] = useState<Record<string, string>>({});

  // Pushing a task onto the global object-panel stack opens the new
  // self-contained task panel (rendered by ObjectPanelHost). A click opens it
  // directly: this used to go through a "selected card" state whose effect only
  // fired when the selection changed, so a card that was opened and closed once
  // could not be opened again.
  const { open: openTaskPanel } = useObjectPanel();
  const openFeature = useCallback((feature: TaskFeature) => {
    openTaskPanel({ type: 'task', id: feature.id });
  }, [openTaskPanel]);
  // Drag state
  const [activeDealId, setActiveDealId] = useState<string | null>(null);
  const [draggedFeatureOriginalColumn, setDraggedFeatureOriginalColumn] = useState<{ id: string; column: string } | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filters
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const pipelineFilterConfigs: FilterConfig[] = useMemo(() => [
    { field: 'stage', label: t.projects.pipeline.filterStage, options: columns.map(c => ({ value: c.id, label: stageLabel(c.name, c.systemStatus) })) },
    { field: 'priority', label: t.projects.pipeline.filterPriority, options: [{ value: 'urgent', label: t.projects.pipeline.priorityUrgent }, { value: 'high', label: t.projects.pipeline.priorityHigh }, { value: 'medium', label: t.projects.pipeline.priorityMedium }, { value: 'low', label: t.projects.pipeline.priorityLow }] },
    { field: 'assignee', label: t.projects.pipeline.filterAssignee, options: [{ value: '__unassigned__', label: t.projects.pipeline.filterUnassigned }, ...projectMembers.map(m => ({ value: m.user?.name || m.userId, label: m.user?.name || m.user?.email || t.common.labels.unknown }))] },
    { field: 'due', label: t.projects.pipeline.filterDueDate, filterType: 'date' as const, options: [] },
  ], [columns, projectMembers, t, stageLabel]);

  const containerRef = useRef<HTMLDivElement>(null);
  const stagesScrollRef = useRef<HTMLDivElement>(null);
  const calculationScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchOpen && searchInputRef.current) searchInputRef.current.focus();
  }, [searchOpen]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } })
  );

  const isStageCollision = (c: Collision) => c.id?.toString().startsWith('stage-');

  const customCollisionDetection: CollisionDetection = (args) => {
    const pointerCollisions = pointerWithin(args);
    const stageCollisions = pointerCollisions.filter((c) => isStageCollision(c));
    if (stageCollisions.length > 0) return stageCollisions;
    const rectCollisions = rectIntersection(args);
    const rectStageCollisions = rectCollisions.filter((c) => isStageCollision(c));
    if (rectStageCollisions.length > 0) return rectStageCollisions;
    return rectCollisions;
  };

  // Fetch tasks on mount
  const loadData = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    setError(null);
    try {
      const [tasksResult, membersResult, stagesResult] = await Promise.all([
        // Every page: a single `list` call stopped at 50 tasks.
        tasksApi.listAllPages(projectId),
        membersApi.list(projectId),
        stagesApi.list(projectId),
      ]);
      let statusToStageId = new Map<string, string>();
      if (stagesResult.success && stagesResult.data) {
        const stages = stagesResult.data as RawPipelineStage[];
        statusToStageId = buildStatusToStageId(stages);
        setColumns(stages.map((s) => ({ id: s.id, name: s.name || '', color: s.color || '#94a3b8', systemStatus: s.systemStatus || s.id })));
      }
      if (tasksResult.success && tasksResult.data) {
        const tasks = tasksResult.data as RawPipelineTask[];
        setFeatures(tasks.map((task) => mapTaskToFeature(task, statusToStageId, featureFallbacks)));
      } else {
        setError(tasksResult.error || t.projects.pipeline.failedToLoadData);
      }
      if (membersResult.success && membersResult.data) {
        setProjectMembers(membersResult.data);
      }
    } catch {
      setError(t.projects.pipeline.failedToLoadData);
    } finally {
      setIsLoading(false);
    }
    // `t` intentionally excluded — loadData is a dependency of the mount effect
    // below, and keying it on the translation object would re-fetch on every
    // locale switch instead of just re-translating the (rare) error string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => { void loadData(); }, [loadData]);

  // A task deleted from the task panel disappears from this list right away.
  useEffect(() => {
    const onDeleted = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) setFeatures((prev) => prev.filter((f) => f.id !== id));
    };
    window.addEventListener(TASK_DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(TASK_DELETED_EVENT, onDeleted);
  }, []);

  const statusToStageId = useMemo(() => buildStatusToStageId(columns), [columns]);

  // Filtered features
  const filteredFeatures = useMemo(() => {
    let result = features;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(f =>
        f.name.toLowerCase().includes(query) ||
        f.taskKey?.toLowerCase().includes(query) ||
        // Lets "1042" / "#1042" find the card by its number.
        taskNumberMatches(f.number, query) ||
        f.owner?.name.toLowerCase().includes(query)
      );
    }

    if (activeFilters.length > 0) {
      for (const filter of activeFilters) {
        result = result.filter(f => featureMatchesFilter(f, filter));
      }
    }

    return result;
  }, [features, searchQuery, activeFilters]);

  // Drag handlers
  const handleDragStart = (event: DragStartEvent) => {
    const activeId = event.active.id as string;
    if (activeId.startsWith('sortable-stage-')) {
      setActiveDealId(null);
    } else {
      setActiveDealId(activeId);
      const feature = features.find(f => f.id === activeId);
      if (feature) {
        setDraggedFeatureOriginalColumn({ id: feature.id, column: feature.column });
      }
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDealId(null);

    if (!canWrite || !over) { setDraggedFeatureOriginalColumn(null); return; }

    const activeId = active.id as string;
    const overId = over.id as string;

    // Stage reordering
    if (activeId.startsWith(STAGE_SORTABLE_PREFIX)) {
      const fromId = activeId.replace(STAGE_SORTABLE_PREFIX, '');
      const toId = resolveStageDropId(overId);

      // The reorder is computed and persisted here, not inside a state updater:
      // React may call an updater twice (StrictMode), which sent the request twice.
      if (fromId !== toId) {
        const next = reorderStages(columns, fromId, toId);
        if (next) {
          setColumns(next);
          void persistStageOrder(next, columns);
        }
      }
      setDraggedFeatureOriginalColumn(null);
      return;
    }

    // Task movement
    if (!draggedFeatureOriginalColumn) return;
    const movedFeature = features.find(f => f.id === draggedFeatureOriginalColumn.id);
    if (!movedFeature) { setDraggedFeatureOriginalColumn(null); return; }

    const originalColumn = draggedFeatureOriginalColumn.column;
    const targetStageId = resolveTaskDropStageId(overId, features);
    const overFeature = features.find(f => f.id === overId && f.id !== movedFeature.id);
    setDraggedFeatureOriginalColumn(null);
    if (!targetStageId) return;

    // Where the card lands: next to the card it was dropped on. Dropped on an
    // empty part of a column, it keeps its place in the list order.
    const reordered = overFeature
      ? arrayMove(
          features.map(f => f.id === movedFeature.id ? { ...f, column: targetStageId } : f),
          features.findIndex(f => f.id === movedFeature.id),
          features.findIndex(f => f.id === overFeature.id),
        )
      : features.map(f => f.id === movedFeature.id ? { ...f, column: targetStageId } : f);

    if (targetStageId === originalColumn) {
      // Ordering within a column: only the position changes.
      if (!overFeature) return;
      setFeatures(reordered);
      const result = await tasksApi.reorderTasks(projectId, reordered.map(f => f.id));
      if (!result.success) {
        setFeatures(features);
        toast.error(t.projects.pipeline.taskReorderFailed);
      }
      return;
    }

    // Optimistic update
    setFeatures(reordered);

    const targetStage = columns.find(c => c.id === targetStageId);
    const originalStage = columns.find(c => c.id === originalColumn);
    const result = await persistStageChange(
      projectId,
      movedFeature.id,
      targetStageId,
      originalStage?.systemStatus ?? originalColumn,
      targetStage?.systemStatus ?? targetStageId,
    );
    if (!result.success) {
      toast.error(t.projects.pipeline.taskUpdateFailed);
      void loadData();
      return;
    }
    toast.success(t.projects.pipeline.taskMoved);
    if (overFeature) {
      const reorderResult = await tasksApi.reorderTasks(projectId, reordered.map(f => f.id));
      if (!reorderResult.success) toast.error(t.projects.pipeline.taskReorderFailed);
    }
    // Completing a recurring task creates its next occurrence: show it.
    if (result.data?.nextTaskId) {
      const next = await tasksApi.get(projectId, result.data.nextTaskId);
      if (next.success && next.data) {
        setFeatures(prev => [...prev, mapTaskToFeature(next.data as RawPipelineTask, statusToStageId, featureFallbacks)]);
        toast.success(t.projects.pipeline.nextRecurringCreated);
      }
    }
  };

  const activeDeal = activeDealId ? features.find(f => f.id === activeDealId) : null;

  // Task CRUD
  const handleOpenCreateDialog = (columnId: string) => {
    if (!canWrite) return;
    setSelectedColumn(columnId);
    setShowCreateDialog(true);
  };

  const handleTaskDialogSave = async (data: {
    title: string;
    description?: string;
    status: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    assignee?: string;
    assigneeIds?: string[];
    dueDate?: Date;
    duration?: number;
    repeat?: { frequency: string; interval?: number; unit?: string };
  }) => {
    if (!canWrite) return;
    // Resolve assigneeIds from the dialog
    const resolvedIds = data.assigneeIds || (data.assignee
      ? [projectMembers.find(m => m.user?.name === data.assignee)?.userId].filter(Boolean) as string[]
      : undefined);

    // Prefer the stage the user picked in the dialog; fall back to the column it
    // was opened from.
    const targetStageId = (data.status && columns.some(c => c.id === data.status))
      ? data.status
      : (selectedColumn || 'todo');

    setIsCreating(true);
    try {
      const targetStage = columns.find(c => c.id === targetStageId);
      const result = await tasksApi.create(projectId, {
        title: data.title,
        description: data.description,
        stageId: targetStageId,
        status: targetStage?.systemStatus ?? targetStageId,
        priority: data.priority,
        assigneeIds: resolvedIds,
        dueDate: data.dueDate?.toISOString(),
        duration: data.duration,
      });
      if (result.success && result.data) {
        const newTask = result.data;
        setFeatures(prev => [...prev, mapTaskToFeature(newTask, statusToStageId, featureFallbacks)]);
        setShowCreateDialog(false);
        toast.success(t.projects.pipeline.taskCreated);
      } else {
        toast.error(t.projects.pipeline.taskCreateFailed);
      }
    } catch {
      toast.error(t.projects.pipeline.taskCreateFailed);
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenEditStage = (stage: StageColumn) => {
    if (!canWrite) return;
    setEditingStage(stage);
    setEditStageName(stage.name);
    setEditStageColor(stage.color);
    setShowEditStageDialog(true);
  };

  const handleSaveEditStage = async () => {
    if (!canWrite || !editingStage || !editStageName.trim()) return;
    const result = await stagesApi.update(projectId, editingStage.id, { name: editStageName.trim(), color: editStageColor });
    if (result.success) {
      setColumns(columns.map(col =>
        col.id === editingStage.id ? { ...col, name: editStageName.trim(), color: editStageColor } : col
      ));
      setShowEditStageDialog(false);
      setEditingStage(null);
      toast.success(t.projects.pipeline.stageUpdated);
    } else {
      toast.error(t.projects.pipeline.stageUpdateFailed);
    }
  };

  const handleDeleteStage = async (stageId: string) => {
    if (!canWrite) return;
    const remaining = columns.filter(col => col.id !== stageId);
    if (remaining.length === 0) { toast.error(t.projects.pipeline.cannotDeleteLastStage); return; }
    const result = await stagesApi.delete(projectId, stageId, remaining[0].id);
    if (result.success) {
      setFeatures(features.map(f => f.column === stageId ? { ...f, column: remaining[0].id } : f));
      setColumns(remaining);
      toast.success(t.projects.pipeline.stageDeleted);
    } else if (result.status === 400) {
      // The target stage was refused (gone, or from another project).
      toast.error(t.projects.pipeline.stageDeleteInvalidTarget);
    } else {
      toast.error(t.projects.pipeline.stageDeleteFailed);
    }
  };

  const handleDuplicateStage = async (stage: StageColumn) => {
    if (!canWrite) return;
    const idx = columns.findIndex(col => col.id === stage.id);
    const result = await stagesApi.create(projectId, { name: `${stage.name} ${t.projects.pipeline.stageCopySuffix}`, color: stage.color, position: idx + 1, systemStatus: stage.systemStatus });
    if (result.success && result.data) {
      const newStage: StageColumn = { id: result.data.id, name: result.data.name, color: result.data.color || stage.color, systemStatus: result.data.systemStatus || stage.systemStatus };
      const next = [...columns];
      next.splice(idx + 1, 0, newStage);
      setColumns(next);
      toast.success(t.projects.pipeline.stageDuplicated);
    } else {
      toast.error(t.projects.pipeline.stageDuplicateFailed);
    }
  };

  // Saves a new stage order; when the server refuses, the previous order comes
  // back and the user is told (a failed save used to be swallowed silently).
  const persistStageOrder = useCallback(async (ordered: StageColumn[], previous: StageColumn[]) => {
    if (!canWrite) return;
    const result = await stagesApi.reorder(projectId, ordered.map(s => s.id));
    if (!result.success) {
      setColumns(previous);
      toast.error(t.projects.pipeline.stageReorderFailed);
    }
  }, [canWrite, projectId, t]);

  const handleMoveStageLeft = (stageId: string) => {
    if (!canWrite) return;
    const idx = columns.findIndex(col => col.id === stageId);
    if (idx <= 0) return;
    const next = [...columns];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setColumns(next);
    void persistStageOrder(next, columns);
  };

  const handleMoveStageRight = (stageId: string) => {
    if (!canWrite) return;
    const idx = columns.findIndex(col => col.id === stageId);
    if (idx >= columns.length - 1) return;
    const next = [...columns];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setColumns(next);
    void persistStageOrder(next, columns);
  };


  // Calculation display
  const getCalculationDisplay = (columnId: string) => {
    const columnTasks = filteredFeatures.filter(f => f.column === columnId);
    const taskCount = columnTasks.length;
    const calcType = columnCalculations[columnId] || 'count';
    const overdueTasks = columnTasks.filter(t => t.endAt < new Date()).length;
    const assigned = columnTasks.filter(t => t.owner).length;
    const unassigned = columnTasks.filter(t => !t.owner).length;

    switch (calcType) {
      case 'count': return <span><span className="font-medium">{taskCount}</span> {taskCount === 1 ? t.projects.pipeline.taskSingular : t.projects.pipeline.taskPlural}</span>;
      case 'overdue': return <span><span className="font-medium">{overdueTasks}</span> {t.projects.pipeline.overdue}</span>;
      case 'assigned': return <span><span className="font-medium">{assigned}</span> {t.projects.pipeline.assigned}</span>;
      case 'unassigned': return <span><span className="font-medium">{unassigned}</span> {t.projects.pipeline.unassignedLabel}</span>;
      case 'none': return <span className="text-gray-400">-</span>;
      default: return <span><span className="font-medium">{taskCount}</span> {taskCount === 1 ? t.projects.pipeline.taskSingular : t.projects.pipeline.taskPlural}</span>;
    }
  };

  // Loading / error states
  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <p className="text-destructive">{error}</p>
          <Button onClick={loadData}>{t.projects.pipeline.retry}</Button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0">
        <div className="flex items-center justify-between px-4 h-[53px] border-b border-gray-200 dark:border-border">
          <FilterPills
            filters={activeFilters}
            filterConfigs={pipelineFilterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative flex items-center">
              <div className={cn("flex items-center transition-all duration-200 ease-out", searchOpen ? "w-48" : "w-8")}>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200", searchOpen && "opacity-0 pointer-events-none absolute")}
                  onClick={() => setSearchOpen(true)}
                >
                  <Search className="h-4 w-4" />
                </Button>
                <div className={cn("relative transition-all duration-200 ease-out", searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none")}>
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder={t.projects.pipeline.searchTasks}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onBlur={() => !searchQuery && setSearchOpen(false)}
                    className="h-8 w-full pl-8 pr-3 text-sm border border-gray-200 dark:border-border rounded-md bg-white dark:bg-background focus:outline-none"
                  />
                </div>
              </div>
            </div>
            {/* Add Task */}
            {canWrite && (
              <Button
                size="sm"
                className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 relative z-10"
                onClick={() => handleOpenCreateDialog(columns[0]?.id || 'todo')}
              >
                <Plus className="h-4 w-4 mr-0.5" />
                <span>{t.projects.pipeline.addTask}</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 flex flex-col overflow-hidden pb-0 select-none">
        <DndContext sensors={sensors} collisionDetection={customCollisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div
            ref={stagesScrollRef}
            className="flex gap-4 flex-1 overflow-x-auto overflow-y-visible gantt-scroll pb-0"
            style={{ padding: '16px 16px' }}
            onScroll={(e) => {
              if (calculationScrollRef.current) calculationScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }}
          >
            <SortableContext items={columns.map(s => `sortable-stage-${s.id}`)} strategy={horizontalListSortingStrategy}>
              {columns.map((column, colIdx) => {
                const stageFeatures = filteredFeatures.filter(f => f.column === column.id);
                return (
                  <SortableStage key={column.id} id={column.id} disabled={!canWrite}>
                    <div className="flex flex-col h-full overflow-visible">
                      <DroppableStage id={column.id} containerRef={containerRef}>
                        <div className="flex flex-col h-full">
                          <PipelineStageHeader
                            stage={column}
                            taskCount={stageFeatures.length}
                            canWrite={canWrite}
                            onAddTask={() => handleOpenCreateDialog(column.id)}
                            onEditStage={() => handleOpenEditStage(column)}
                            onDeleteStage={() => handleDeleteStage(column.id)}
                            onDuplicateStage={() => handleDuplicateStage(column)}
                            onMoveLeft={() => handleMoveStageLeft(column.id)}
                            onMoveRight={() => handleMoveStageRight(column.id)}
                            isFirst={colIdx === 0}
                            isLast={colIdx === columns.length - 1}
                          />
                          <div className="flex-1 flex flex-col">
                            <div className="space-y-2">
                              <SortableContext items={stageFeatures.map(d => d.id)} strategy={verticalListSortingStrategy}>
                                {stageFeatures.map((feature) => (
                                  <TaskCard key={feature.id} feature={feature} availableLabels={availableLabels} canWrite={canWrite} onClick={() => openFeature(feature)} />
                                ))}
                              </SortableContext>
                            </div>
                            {canWrite && stageFeatures.length === 0 && (
                              <Button
                                variant="ghost"
                                className="w-full h-auto py-2 px-4 bg-gray-50 dark:bg-background/50 border border-dashed border-gray-200 dark:border-border rounded-lg text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-background flex items-center justify-center gap-2 text-sm font-medium"
                                onClick={() => handleOpenCreateDialog(column.id)}
                              >
                                <Plus className="h-4 w-4" />
                                {t.projects.pipeline.newTask}
                              </Button>
                            )}
                            <div className="flex-1 min-h-[200px]" />
                          </div>
                        </div>
                      </DroppableStage>
                    </div>
                  </SortableStage>
                );
              })}
            </SortableContext>

          </div>

          <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
            {activeDeal ? (
              <div className="scale-[1.02]">
                <div className="bg-white dark:bg-background rounded-lg border border-gray-125 dark:border-border p-3 w-[240px] shadow-lg">
                  <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate block">{activeDeal.name}</span>
                  {activeDeal.owner && (
                    <div className="flex items-center gap-2 mt-2">
                      <Avatar className="h-4 w-4 rounded"><AvatarFallback className="text-[9px] bg-cyan-500 text-white rounded">{activeDeal.owner.name.charAt(0).toUpperCase()}</AvatarFallback></Avatar>
                      <span className="text-sm text-gray-600 dark:text-muted-foreground">{activeDeal.owner.name}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-2">
                    <Calendar className="h-3.5 w-3.5 text-gray-400" />
                    <span className="text-sm text-gray-600 dark:text-muted-foreground">{formatShortDateNow(activeDeal.endAt)}</span>
                  </div>
                  {activeDeal.labels && activeDeal.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      <LabelOverflowList
                        labels={activeDeal.labels
                          .map((labelId) => availableLabels.find((l) => l.id === labelId))
                          .filter((l): l is NonNullable<typeof l> => !!l)
                          .map((l) => ({ id: l.id, name: l.name, color: l.color }))}
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Calculation bar at bottom */}
      <div
        className="flex-shrink-0 bg-white dark:bg-background border-t border-gray-100 dark:border-border z-40 py-0"
      >
        <div
          ref={calculationScrollRef}
          className="flex gap-4 h-11 overflow-x-auto overflow-y-hidden scrollbar-hidden px-6 py-0"
          onScroll={(e) => {
            if (stagesScrollRef.current) stagesScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
        >
          {columns.map((column) => (
            <div key={`calc-${column.id}`} className="flex-shrink-0 w-[240px]">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="w-full h-11 flex items-center px-2 hover:bg-gray-50 dark:hover:bg-secondary/30 transition-colors cursor-pointer text-sm text-gray-500 dark:text-muted-foreground text-left outline-none rounded-none justify-start">
                    {getCalculationDisplay(column.id)}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuItem onClick={() => setColumnCalculations({ ...columnCalculations, [column.id]: 'count' })} className={columnCalculations[column.id] === 'count' || !columnCalculations[column.id] ? 'bg-gray-100 dark:bg-secondary' : ''}>
                    <Hash className="mr-1.5 h-4 w-4" /> {t.projects.pipeline.countAll}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setColumnCalculations({ ...columnCalculations, [column.id]: 'overdue' })} className={columnCalculations[column.id] === 'overdue' ? 'bg-gray-100 dark:bg-secondary' : ''}>
                    <Clock className="mr-1.5 h-4 w-4" /> {t.projects.pipeline.countOverdue}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setColumnCalculations({ ...columnCalculations, [column.id]: 'assigned' })} className={columnCalculations[column.id] === 'assigned' ? 'bg-gray-100 dark:bg-secondary' : ''}>
                    <UserCheck className="mr-1.5 h-4 w-4" /> {t.projects.pipeline.countAssigned}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setColumnCalculations({ ...columnCalculations, [column.id]: 'unassigned' })} className={columnCalculations[column.id] === 'unassigned' ? 'bg-gray-100 dark:bg-secondary' : ''}>
                    <UserX className="mr-1.5 h-4 w-4" /> {t.projects.pipeline.countUnassigned}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setColumnCalculations({ ...columnCalculations, [column.id]: 'none' })} className={columnCalculations[column.id] === 'none' ? 'bg-gray-100 dark:bg-secondary' : ''}>
                    <Minus className="mr-1.5 h-4 w-4" /> {t.projects.pipeline.none}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
          <div className="flex-shrink-0 w-8" />
        </div>
      </div>

      {/* Create/Edit Task Dialog */}
      <TaskDialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          setShowCreateDialog(open);
          if (!open) setEditingCrmTask(null);
        }}
        editingTask={editingCrmTask}
        availableAssignees={projectMembers.filter(m => m.user?.name).map(m => ({ id: m.userId, name: m.user!.name }))}
        availableCompanies={[]}
        availableLabels={availableLabels}
        availableStatuses={columns.map(c => ({ id: c.id, label: stageLabel(c.name, c.systemStatus), color: c.color }))}
        onCreateLabel={handleCreateLabel}
        hideRecord
        onSave={handleTaskDialogSave}
        onUpdate={(taskId, data) => {
          if (!canWrite) return;
          const updateData: Parameters<typeof tasksApi.update>[2] = {};
          if (data.title) updateData.title = data.title;
          // Cleared fields go out as an explicit `null`: `undefined` is dropped by
          // JSON, so a removed description / due date / recurrence stayed saved.
          if (data.description !== undefined) updateData.description = data.description || null;
          if (data.status) {
            const stage = columns.find(c => c.id === data.status);
            if (stage) {
              updateData.stageId = stage.id;
              updateData.status = stage.systemStatus ?? stage.id;
            } else {
              updateData.status = data.status;
            }
          }
          if (data.priority) updateData.priority = data.priority;
          if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? data.dueDate.toISOString() : null;
          if (data.duration !== undefined) updateData.duration = data.duration;
          if (data.labels !== undefined) updateData.labels = data.labels;
          if (data.repeat !== undefined) updateData.repeat = data.repeat;
          if (data.assigneeIds !== undefined) updateData.assigneeIds = data.assigneeIds;

          void (async () => {
            const result = await tasksApi.update(projectId, taskId, updateData);
            if (result.success) {
              // The card follows the stage the task now sits in (a stage id), not
              // the stage's status.
              const patchFeature = (f: TaskFeature): TaskFeature => ({
                ...f,
                ...(updateData.title && { name: updateData.title }),
                ...(updateData.description !== undefined && { description: updateData.description ?? undefined }),
                ...(updateData.stageId && { column: updateData.stageId }),
                ...(updateData.priority && { priority: updateData.priority }),
                ...(updateData.dueDate !== undefined && {
                  hasDueDate: !!updateData.dueDate,
                  ...(updateData.dueDate && { endAt: new Date(updateData.dueDate) }),
                }),
                ...(updateData.labels !== undefined && { labels: updateData.labels }),
              });
              setFeatures(prev => prev.map(f => f.id === taskId ? patchFeature(f) : f));
              setShowCreateDialog(false);
              setEditingCrmTask(null);
              toast.success(t.projects.pipeline.taskUpdated);
            } else {
              toast.error(t.projects.pipeline.taskUpdateFailed);
            }
          })();
        }}
        isPending={isCreating}
      />

      {/* Edit Stage Dialog */}
      <Dialog open={showEditStageDialog} onOpenChange={setShowEditStageDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.projects.pipeline.editStageTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-stage-name">{t.projects.pipeline.stageName}</Label>
              <Input id="edit-stage-name" placeholder={t.projects.pipeline.stageNamePlaceholder} value={editStageName} onChange={(e) => setEditStageName(e.target.value)} className="focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-gray-400 dark:focus-visible:border-gray-500" />
            </div>
            <div className="flex gap-2 flex-wrap">
              {stageColors.map((color) => (
                <Button key={color} type="button" variant="ghost" className={`rounded-md transition-all flex-shrink-0 p-0 ${editStageColor === color ? 'ring-2 ring-primary ring-offset-2' : ''}`} style={{ backgroundColor: color, width: '31px', height: '31px' }} onClick={() => setEditStageColor(color)} />
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditStageDialog(false)}>{t.projects.pipeline.cancel}</Button>
            <Button onClick={handleSaveEditStage} disabled={!editStageName.trim()}>{t.projects.pipeline.saveChanges}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feature detail panel is now rendered globally via ObjectPanelHost. */}
    </div>
  );
};

export default function Page() {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <PipelinePage />
    </div>
  );
}
