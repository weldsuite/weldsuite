
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
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  useSortable,
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
  Check,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { toast } from 'sonner';
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
import { Badge } from '@weldsuite/ui/components/badge';
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
import { cn } from '@/lib/utils';
import { LabelOverflowList } from '@/app/weldflow/lib/label-overflow-list';
import { type TaskComment } from '@/components/task-detail';
import { useObjectPanel } from '@/components/object-panel';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
import { useAuth } from '@clerk/clerk-react';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { FilterPills } from '@/components/entity-list';
import type { FilterConfig, ActiveFilter } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

// ---------- Types ----------

interface Tag {
  name: string;
  color: string;
}

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
  taskKey?: string;
  commentsCount?: number;
  attachmentsCount?: number;
  tags?: Tag[];
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

function mapTaskToFeature(task: any, statusToStageId?: Map<string, string>): TaskFeature {
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
    name: task.title || 'Untitled Task',
    description: task.description,
    startAt: startDate,
    endAt: endDate,
    hasStartDate: !!task.startDate,
    hasDueDate: !!task.dueDate,
    duration: task.duration ?? undefined,
    estimatedHours: task.estimatedHours ?? undefined,
    column: resolvedColumn,
    owner: task.assignee ? {
      id: task.assignee.id || task.assigneeId,
      name: task.assignee.name || task.assigneeName || 'Unknown',
      image: task.assignee.avatar || task.assignee.image,
    } : undefined,
    owners: Array.isArray(task.assignees) && task.assignees.length > 0
      ? task.assignees.map((a: any) => ({ id: a.id, name: a.name, image: a.avatar || a.image }))
      : undefined,
    priority: task.priority,
    taskKey: task.key,
    commentsCount: task.commentsCount || task._count?.comments || 0,
    attachmentsCount: task.attachmentsCount || task._count?.attachments || 0,
    tags: (task.tags || []).map((tag: string | Tag) => {
      if (typeof tag === 'object' && tag !== null) return tag;
      try {
        const parsed = JSON.parse(tag);
        if (parsed.name && parsed.color) return parsed as Tag;
      } catch {}
      return { name: String(tag), color: '#94a3b8' };
    }),
    labels: task.labels || undefined,
  };
}

const shortDateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// ---------- DroppableStage ----------

function DroppableStage({ id, children, containerRef }: { id: string; children: React.ReactNode; containerRef?: React.RefObject<HTMLDivElement | null> }) {
  const { isOver, setNodeRef } = useDroppable({ id: `stage-${id}` });
  const stageRef = useRef<HTMLDivElement>(null);
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
        (stageRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
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

function SortableStage({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, transform, transition, isDragging } = useSortable({
    id: `sortable-stage-${id}`,
    data: { type: 'stage', stageId: id },
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

function TaskCard({ feature, isDragging, onClick, availableLabels = [] }: { feature: TaskFeature; isDragging?: boolean; onClick?: () => void; availableLabels?: ProjectLabel[] }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging: isSortableDragging } = useSortable({ id: feature.id });

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
            {shortDateFormatter.format(feature.startAt)}
          </span>
        </div>
      )}

      {/* Due Date */}
      {feature.hasDueDate && (
        <div className="flex items-center gap-2 mt-2.5">
          <Calendar className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {shortDateFormatter.format(feature.endAt)}
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

      {/* Tags */}
      {feature.tags && feature.tags.length > 0 && (
        <div className="flex items-center gap-2 mt-3">
          <Hash className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <div className="flex flex-wrap gap-1 min-w-0">
            {feature.tags.slice(0, 3).map((tag, index) => (
              <Badge key={index} className="text-[10px] px-1.5 py-0 h-5 text-gray-700 dark:text-gray-800" style={{ backgroundColor: tag.color }}>
                {tag.name}
              </Badge>
            ))}
            {feature.tags.length > 3 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">+{feature.tags.length - 3}</Badge>
            )}
          </div>
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
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      className={cn(
        "group relative bg-white dark:bg-background rounded-lg border border-gray-125 dark:border-border",
        "hover:bg-gray-50 dark:hover:bg-secondary/70 cursor-grab active:cursor-grabbing w-full",
        "p-3 transition-all duration-200",
        isSortableDragging && "!bg-gray-100 dark:!bg-gray-800 !border-transparent",
        (isDragging || isSortableDragging) && "opacity-50",
        onClick && "cursor-pointer"
      )}
    >
      {isSortableDragging ? <div className="invisible">{cardContent}</div> : cardContent}
    </div>
  );
}

// ---------- StageHeader ----------

function PipelineStageHeader({ stage, taskCount, onAddTask, onEditStage, onDeleteStage, onDuplicateStage, onMoveLeft, onMoveRight, isFirst, isLast }: {
  stage: StageColumn;
  taskCount: number;
  onAddTask: () => void;
  onEditStage: () => void;
  onDeleteStage: () => void;
  onDuplicateStage: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { t } = useI18n();
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
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="flex items-center gap-2 ml-1 h-auto p-0">
              <div className="w-3 h-3 rounded" style={{ backgroundColor: stage.color }} />
              <h3 className="font-medium text-sm text-gray-900 dark:text-foreground">{stage.name}</h3>
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
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:bg-gray-200 dark:hover:bg-accent"
          onClick={onAddTask}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

// ---------- Main Pipeline Component ----------

const PipelinePage = () => {
  const params = useParams();
  const projectId = params.projectId as string;
  const { t } = useI18n();

  const [features, setFeatures] = useState<TaskFeature[]>([]);
  const [columns, setColumns] = useState<StageColumn[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null);
  const [editingCrmTask, setEditingCrmTask] = useState<CrmTask | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [availableLabels, setAvailableLabels] = useState<ProjectLabel[]>([]);

  // Fetch this project's labels (plus legacy workspace-wide labels)
  useEffect(() => {
    async function loadLabels() {
      const result = await labelsApi.list(projectId);
      if (result.success && result.data) {
        setAvailableLabels(result.data);
      }
    }
    loadLabels();
  }, [projectId]);

  const handleCreateLabel = useCallback(async (data: { name: string; color: string }): Promise<ProjectLabel | null> => {
    const result = await labelsApi.create({ ...data, projectId });
    if (result.success && result.data) {
      const newLabel: ProjectLabel = { id: result.data.id, name: data.name, color: data.color };
      setAvailableLabels(prev => [newLabel, ...prev]);
      return newLabel;
    }
    toast.error(t.projects.pipeline.labelCreateFailed);
    return null;
  }, [projectId, t]);

  // Edit stage state
  const [showEditStageDialog, setShowEditStageDialog] = useState(false);
  const [editingStage, setEditingStage] = useState<StageColumn | null>(null);
  const [editStageName, setEditStageName] = useState('');
  const [editStageColor, setEditStageColor] = useState('');

  // Calculation type per column
  const [columnCalculations, setColumnCalculations] = useState<Record<string, string>>({});

  // Detail panel state
  const [selectedFeature, setSelectedFeature] = useState<TaskFeature | null>(null);
  // Pushing a task onto the global object-panel stack opens the new
  // self-contained task panel (rendered by ObjectPanelHost).
  const { open: openTaskPanel } = useObjectPanel();
  useEffect(() => {
    if (selectedFeature) openTaskPanel({ type: 'task', id: selectedFeature.id });
  }, [selectedFeature?.id, openTaskPanel]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const { userId } = useAuth();

  // Fetch comments when a feature is selected
  useEffect(() => {
    if (!selectedFeature) {
      setComments([]);
      return;
    }
    async function loadComments() {
      const result = await tasksApi.listComments(projectId, selectedFeature!.id);
      if (result.success && result.data) {
        setComments(Array.isArray(result.data) ? result.data : []);
      }
    }
    loadComments();
  }, [selectedFeature?.id, projectId]);
  // Drag state
  const [activeDealId, setActiveDealId] = useState<string | null>(null);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  const [draggedFeatureOriginalColumn, setDraggedFeatureOriginalColumn] = useState<{ id: string; column: string } | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filters
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const pipelineFilterConfigs: FilterConfig[] = useMemo(() => [
    { field: 'stage', label: t.projects.pipeline.filterStage, options: columns.map(c => ({ value: c.id, label: c.name })) },
    { field: 'priority', label: t.projects.pipeline.filterPriority, options: [{ value: 'urgent', label: t.projects.pipeline.priorityUrgent }, { value: 'high', label: t.projects.pipeline.priorityHigh }, { value: 'medium', label: t.projects.pipeline.priorityMedium }, { value: 'low', label: t.projects.pipeline.priorityLow }] },
    { field: 'assignee', label: t.projects.pipeline.filterAssignee, options: [{ value: '__unassigned__', label: t.projects.pipeline.filterUnassigned }, ...projectMembers.map(m => ({ value: m.user?.name || m.userId, label: m.user?.name || m.user?.email || 'Unknown' }))] },
    { field: 'due', label: t.projects.pipeline.filterDueDate, filterType: 'date' as const, options: [] },
  ], [columns, projectMembers, t]);

  const containerRef = useRef<HTMLDivElement>(null);
  const stagesScrollRef = useRef<HTMLDivElement>(null);
  const calculationScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchOpen && searchInputRef.current) searchInputRef.current.focus();
  }, [searchOpen]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } })
  );

  const customCollisionDetection = (args: any) => {
    const pointerCollisions = pointerWithin(args);
    const stageCollisions = pointerCollisions.filter((c: any) => c.id?.toString().startsWith('stage-'));
    if (stageCollisions.length > 0) return stageCollisions;
    const rectCollisions = rectIntersection(args);
    const rectStageCollisions = rectCollisions.filter((c: any) => c.id?.toString().startsWith('stage-'));
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
        tasksApi.list(projectId),
        membersApi.list(projectId),
        stagesApi.list(projectId),
      ]);
      const statusToStageId = new Map<string, string>();
      if (stagesResult.success && stagesResult.data) {
        for (const s of stagesResult.data as any[]) {
          statusToStageId.set(s.id, s.id);
          if (s.systemStatus) statusToStageId.set(s.systemStatus, s.id);
        }
        setColumns(stagesResult.data.map((s: any) => ({ id: s.id, name: s.name, color: s.color || '#94a3b8', systemStatus: s.systemStatus || s.id })));
      }
      if (tasksResult.success && tasksResult.data) {
        setFeatures(tasksResult.data.map((t: any) => mapTaskToFeature(t, statusToStageId)));
      } else {
        setError(tasksResult.error || t.projects.pipeline.failedToLoadData);
      }
      if (membersResult.success && membersResult.data) {
        setProjectMembers(membersResult.data);
      }
    } catch (err) {
      setError(t.projects.pipeline.failedToLoadData);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);

  const statusToStageId = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of columns) {
      m.set(c.id, c.id);
      if (c.systemStatus) m.set(c.systemStatus, c.id);
    }
    return m;
  }, [columns]);

  // Filter matching helper
  const matchesFilter = useCallback((feature: TaskFeature, filter: ActiveFilter): boolean => {
    if (!filter.operator || !filter.value) return true;
    const val = filter.value.toLowerCase();

    if (filter.field === 'stage') {
      return filter.operator === 'is' ? feature.column === filter.value : feature.column !== filter.value;
    }
    if (filter.field === 'priority') {
      const p = (feature.priority || '').toLowerCase();
      return filter.operator === 'is' ? p === val : p !== val;
    }
    if (filter.field === 'assignee') {
      if (filter.value === '__unassigned__') {
        return filter.operator === 'is' ? !feature.owner : !!feature.owner;
      }
      const name = (feature.owner?.name || '').toLowerCase();
      return filter.operator === 'is' ? name === val : name !== val;
    }
    if (filter.field === 'due') {
      const dueDate = feature.endAt.toISOString().split('T')[0];
      if (filter.operator === 'is') return dueDate === filter.value;
      if (filter.operator === 'before') return dueDate < filter.value;
      if (filter.operator === 'after') return dueDate > filter.value;
    }
    return true;
  }, []);

  // Filtered features
  const filteredFeatures = useMemo(() => {
    let result = features;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(f =>
        f.name.toLowerCase().includes(query) ||
        f.taskKey?.toLowerCase().includes(query) ||
        f.owner?.name.toLowerCase().includes(query) ||
        f.tags?.some(t => t.name.toLowerCase().includes(query))
      );
    }

    if (activeFilters.length > 0) {
      for (const filter of activeFilters) {
        result = result.filter(f => matchesFilter(f, filter));
      }
    }

    return result;
  }, [features, searchQuery, activeFilters, matchesFilter]);

  // Drag handlers
  const handleDragStart = (event: DragStartEvent) => {
    const activeId = event.active.id as string;
    if (activeId.startsWith('sortable-stage-')) {
      setActiveStageId(activeId.replace('sortable-stage-', ''));
      setActiveDealId(null);
    } else {
      setActiveDealId(activeId);
      setActiveStageId(null);
      const feature = features.find(f => f.id === activeId);
      if (feature) {
        setDraggedFeatureOriginalColumn({ id: feature.id, column: feature.column });
      }
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDealId(null);
    setActiveStageId(null);

    if (!over) { setDraggedFeatureOriginalColumn(null); return; }

    const activeId = active.id as string;
    const overId = over.id as string;

    // Stage reordering
    if (activeId.startsWith('sortable-stage-')) {
      const fromId = activeId.replace('sortable-stage-', '');
      let toId = overId;
      if (overId.startsWith('sortable-stage-')) toId = overId.replace('sortable-stage-', '');
      else if (overId.startsWith('stage-')) toId = overId.replace('stage-', '');

      if (fromId !== toId) {
        setColumns(prev => {
          const oldIdx = prev.findIndex(s => s.id === fromId);
          const newIdx = prev.findIndex(s => s.id === toId);
          if (oldIdx !== -1 && newIdx !== -1) {
            const next = [...prev];
            const [moved] = next.splice(oldIdx, 1);
            next.splice(newIdx, 0, moved);
            persistStageOrder(next);
            return next;
          }
          return prev;
        });
      }
      setDraggedFeatureOriginalColumn(null);
      return;
    }

    // Task movement
    if (!draggedFeatureOriginalColumn) return;
    const movedFeature = features.find(f => f.id === draggedFeatureOriginalColumn.id);
    if (!movedFeature) { setDraggedFeatureOriginalColumn(null); return; }

    let targetStageId: string | undefined;
    if (overId.startsWith('stage-')) targetStageId = overId.replace('stage-', '');
    else if (overId.startsWith('sortable-stage-')) targetStageId = overId.replace('sortable-stage-', '');
    else {
      const overFeature = features.find(f => f.id === overId);
      if (overFeature) targetStageId = overFeature.column;
    }

    if (targetStageId && targetStageId !== draggedFeatureOriginalColumn.column) {
      // Optimistic update
      setFeatures(prev => prev.map(f => f.id === movedFeature.id ? { ...f, column: targetStageId! } : f));

      const targetStage = columns.find(c => c.id === targetStageId);
      const result = await tasksApi.update(projectId, movedFeature.id, {
        stageId: targetStageId,
        status: targetStage?.systemStatus ?? targetStageId,
      });
      if (result.success) {
        toast.success(t.projects.pipeline.taskMoved);
      } else {
        toast.error(t.projects.pipeline.taskUpdateFailed);
        loadData();
      }
    }

    setDraggedFeatureOriginalColumn(null);
  };

  const activeDeal = activeDealId ? features.find(f => f.id === activeDealId) : null;

  // Task CRUD
  const handleOpenCreateDialog = (columnId: string) => {
    setSelectedColumn(columnId);
    setShowCreateDialog(true);
  };

  const handleTaskDialogSave = async (data: {
    title: string;
    description?: string;
    status: string;
    priority?: 'low' | 'medium' | 'high';
    assignee?: string;
    assigneeIds?: string[];
    dueDate?: Date;
    duration?: number;
    repeat?: { frequency: string; interval?: number; unit?: string };
  }) => {
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
        setFeatures(prev => [...prev, mapTaskToFeature(result.data, statusToStageId)]);
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
    setEditingStage(stage);
    setEditStageName(stage.name);
    setEditStageColor(stage.color);
    setShowEditStageDialog(true);
  };

  const handleSaveEditStage = async () => {
    if (!editingStage || !editStageName.trim()) return;
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
    const remaining = columns.filter(col => col.id !== stageId);
    if (remaining.length === 0) { toast.error(t.projects.pipeline.cannotDeleteLastStage); return; }
    const result = await stagesApi.delete(projectId, stageId, remaining[0].id);
    if (result.success) {
      setFeatures(features.map(f => f.column === stageId ? { ...f, column: remaining[0].id } : f));
      setColumns(remaining);
      toast.success(t.projects.pipeline.stageDeleted);
    } else {
      toast.error(t.projects.pipeline.stageDeleteFailed);
    }
  };

  const handleDuplicateStage = async (stage: StageColumn) => {
    const idx = columns.findIndex(col => col.id === stage.id);
    const result = await stagesApi.create(projectId, { name: stage.name + ' (Copy)', color: stage.color, position: idx + 1, systemStatus: stage.systemStatus });
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

  const persistStageOrder = useCallback(async (ordered: StageColumn[]) => {
    await stagesApi.reorder(projectId, ordered.map(s => s.id));
  }, [projectId]);

  const handleMoveStageLeft = async (stageId: string) => {
    const idx = columns.findIndex(col => col.id === stageId);
    if (idx <= 0) return;
    const next = [...columns];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setColumns(next);
    persistStageOrder(next);
  };

  const handleMoveStageRight = async (stageId: string) => {
    const idx = columns.findIndex(col => col.id === stageId);
    if (idx >= columns.length - 1) return;
    const next = [...columns];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setColumns(next);
    persistStageOrder(next);
  };

  // Detail panel
  const handleToggleComplete = async (feature: TaskFeature) => {
    const newColumn = feature.column === 'done' ? 'todo' : 'done';
    setFeatures(features.map(f => f.id === feature.id ? { ...f, column: newColumn } : f));
    setSelectedFeature(prev => prev?.id === feature.id ? { ...prev, column: newColumn } : prev);
    const result = await tasksApi.update(projectId, feature.id, { status: newColumn });
    if (!result.success) {
      setFeatures(features.map(f => f.id === feature.id ? { ...f, column: feature.column } : f));
      setSelectedFeature(prev => prev?.id === feature.id ? { ...prev, column: feature.column } : prev);
      toast.error(t.projects.pipeline.taskStatusUpdateFailed);
    }
  };

  const handleUpdateDescription = async (feature: TaskFeature, description: string) => {
    setFeatures(features.map(f => f.id === feature.id ? { ...f, description } : f));
    setSelectedFeature(prev => prev?.id === feature.id ? { ...prev, description } : prev);
    const result = await tasksApi.update(projectId, feature.id, { description });
    if (!result.success) toast.error(t.projects.pipeline.descriptionUpdateFailed);
  };

  const handleDeleteTask = async (featureId: string) => {
    if (!confirm(t.projects.pipeline.confirmDeleteTask)) return;
    const result = await tasksApi.delete(projectId, featureId);
    if (result.success) {
      setFeatures(features.filter(f => f.id !== featureId));
      setSelectedFeature(null);
      toast.success(t.projects.pipeline.taskDeleted);
    } else {
      toast.error(t.projects.pipeline.taskDeleteFailed);
    }
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
            <Button
              size="sm"
              className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 relative z-10"
              onClick={() => handleOpenCreateDialog(columns[0]?.id || 'todo')}
            >
              <Plus className="h-4 w-4 mr-0.5" />
              <span>{t.projects.pipeline.addTask}</span>
            </Button>
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
                  <SortableStage key={column.id} id={column.id}>
                    <div className="flex flex-col h-full overflow-visible">
                      <DroppableStage id={column.id} containerRef={containerRef}>
                        <div className="flex flex-col h-full">
                          <PipelineStageHeader
                            stage={column}
                            taskCount={stageFeatures.length}
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
                                  <TaskCard key={feature.id} feature={feature} availableLabels={availableLabels} onClick={() => setSelectedFeature(feature)} />
                                ))}
                              </SortableContext>
                            </div>
                            {stageFeatures.length === 0 && (
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
                    <span className="text-sm text-gray-600 dark:text-muted-foreground">{shortDateFormatter.format(activeDeal.endAt)}</span>
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
                  {activeDeal.tags && activeDeal.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {activeDeal.tags.slice(0, 3).map((tag, index) => (
                        <Badge key={index} className="text-[10px] px-1.5 py-0 h-5 text-gray-700 dark:text-gray-800" style={{ backgroundColor: tag.color }}>
                          {tag.name}
                        </Badge>
                      ))}
                      {activeDeal.tags.length > 3 && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">+{activeDeal.tags.length - 3}</Badge>
                      )}
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
        availableStatuses={columns.map(c => ({ id: c.id, label: c.name, color: c.color }))}
        onCreateLabel={handleCreateLabel}
        hideRecord
        onSave={handleTaskDialogSave}
        onUpdate={(taskId, data) => {
          const updateData: Record<string, any> = {};
          if (data.title) updateData.title = data.title;
          if (data.description !== undefined) updateData.description = data.description;
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
          if (data.dueDate !== undefined) updateData.dueDate = data.dueDate?.toISOString();
          if (data.duration !== undefined) updateData.duration = data.duration;
          if (data.labels !== undefined) updateData.labels = data.labels;

          (async () => {
            const result = await tasksApi.update(projectId, taskId, updateData);
            if (result.success) {
              setFeatures(prev => prev.map(f => f.id === taskId ? {
                ...f,
                ...(updateData.title && { name: updateData.title }),
                ...(updateData.description !== undefined && { description: updateData.description }),
                ...(updateData.status && { column: updateData.status }),
                ...(updateData.priority && { priority: updateData.priority }),
              } : f));
              setSelectedFeature(prev => prev?.id === taskId ? {
                ...prev,
                ...(updateData.title && { name: updateData.title }),
                ...(updateData.description !== undefined && { description: updateData.description }),
                ...(updateData.status && { column: updateData.status }),
                ...(updateData.priority && { priority: updateData.priority }),
              } : prev);
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
