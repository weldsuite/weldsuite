
import { useState, useRef, useMemo, useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
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
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@weldsuite/ui/components/button';
import { Plus, Calendar, Search, Flag, Tag, Hash, Clock, CalendarClock } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { LabelOverflowList } from '../lib/label-overflow-list';
import { FilterPills } from '@/components/entity-list';
import type { FilterConfig, ActiveFilter } from '@/components/entity-list';

// ---------- Types ----------

interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'testing' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee?: string;
  assigneeId?: string;
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
}

function formatDuration(minutes: number): string {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

interface PipelineColumn {
  id: Task['status'];
  name: string;
  color: string;
}

interface MyTasksPipelineProps {
  tasks: Task[];
  availableLabels: ProjectLabel[];
  filterConfigs: FilterConfig[];
  onTaskClick: (task: Task) => void;
  onStatusChange: (taskId: string, newStatus: Task['status']) => void;
  onReorder?: (columnId: Task['status'], taskIds: string[]) => void;
  onCreateTask: (status?: Task['status']) => void;
  viewToggle: React.ReactNode;
}

// ---------- Constants ----------

const columnColors: Record<string, string> = {
  backlog: '#94a3b8',
  todo: '#c4b5fd',
  in_progress: '#93c5fd',
  in_review: '#fcd34d',
  testing: '#a78bfa',
  done: '#5eead4',
  cancelled: '#f87171',
};

const priorityConfigBase: Record<string, { color: string; bg: string }> = {
  low: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  medium: { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  high: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  urgent: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  critical: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
};

const shortDateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

// ---------- DroppableColumn ----------

function DroppableColumn({ id, children, containerRef }: { id: string; children: React.ReactNode; containerRef?: React.RefObject<HTMLDivElement | null> }) {
  const { isOver, setNodeRef } = useDroppable({ id: `stage-${id}` });
  const stageRef = useRef<HTMLDivElement>(null);
  const [overlayStyle, setOverlayStyle] = useState<React.CSSProperties>({});

  // Update overlay position when dragging over
  if (isOver && stageRef.current) {
    const rect = stageRef.current.getBoundingClientRect();
    const containerBottom = containerRef?.current ? containerRef.current.getBoundingClientRect().bottom : undefined;
    const newStyle: React.CSSProperties = {
      position: 'fixed',
      top: rect.top - 16,
      left: rect.left - 8,
      width: rect.width + 16,
      bottom: containerBottom !== undefined ? window.innerHeight - containerBottom : 0,
      borderRadius: 0,
    };
    if (overlayStyle.top !== newStyle.top || overlayStyle.left !== newStyle.left) {
      setOverlayStyle(newStyle);
    }
  }

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

// ---------- TaskCard ----------

function TaskCard({ task, availableLabels = [], priorityConfig, unassignedLabel, onClick }: { task: Task; availableLabels?: ProjectLabel[]; priorityConfig: Record<string, { label: string; color: string; bg: string }>; unassignedLabel: string; onClick?: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : (transition || 'transform 200ms cubic-bezier(0.18, 0.67, 0.6, 1.22)'),
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
    if (!hasDragged.current && onClick && !isDragging) {
      e.stopPropagation();
      onClick();
    }
  };

  const cardContent = (
    <>
      {/* Title */}
      <span className="font-medium text-gray-900 dark:text-foreground truncate block" style={{ fontSize: '15px' }}>
        {task.title}
      </span>

      {/* Assignee */}
      <div className="flex items-center gap-2 mt-2">
        <Avatar className="h-4 w-4 rounded-[5px]">
          {task.assignee ? (
            <>
              <AvatarImage src={task.assignees?.[0]?.avatar} className="rounded-[5px]" />
              <AvatarFallback className="text-[9px] bg-cyan-500 text-white rounded-[5px]">
                {task.assignee.charAt(0).toUpperCase()}
              </AvatarFallback>
            </>
          ) : (
            <AvatarFallback className="text-[9px] bg-gray-100 text-gray-400 dark:bg-secondary dark:text-muted-foreground rounded-[5px]">
              ?
            </AvatarFallback>
          )}
        </Avatar>
        <span className="text-sm text-gray-600 dark:text-muted-foreground truncate">
          {task.assignee || unassignedLabel}
        </span>
      </div>

      {/* Priority */}
      {task.priority && priorityConfig[task.priority] && (
        <div className="flex items-center gap-2 mt-2.5">
          <Flag className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className={cn("px-2 py-0.5 rounded text-[12px] font-medium", priorityConfig[task.priority].color, priorityConfig[task.priority].bg)}>
            {priorityConfig[task.priority].label}
          </span>
        </div>
      )}

      {/* Start Date */}
      {task.startDate && (
        <div className="flex items-center gap-2 mt-2.5">
          <CalendarClock className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {shortDateFormatter.format(task.startDate)}
          </span>
        </div>
      )}

      {/* Due Date */}
      {task.dueDate && (
        <div className="flex items-center gap-2 mt-2.5">
          <Calendar className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {shortDateFormatter.format(task.dueDate)}
          </span>
        </div>
      )}

      {/* Duration / estimated hours */}
      {(task.duration != null || task.estimatedHours != null) && (
        <div className="flex items-center gap-2 mt-2.5">
          <Clock className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {task.duration != null
              ? formatDuration(task.duration)
              : `${task.estimatedHours}h`}
          </span>
        </div>
      )}

      {/* Labels */}
      {task.labels && task.labels.length > 0 && (
        <div className="flex items-center gap-2 mt-3">
          <Tag className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <LabelOverflowList
            className="flex-1"
            labels={task.labels
              .map((labelId) => availableLabels.find((l) => l.id === labelId))
              .filter((l): l is NonNullable<typeof l> => !!l)
              .map((l) => ({ id: l.id, name: l.name, color: l.color }))}
          />
        </div>
      )}

      {/* Tags */}
      {task.tags && task.tags.length > 0 && (
        <div className="flex items-center gap-2 mt-3">
          <Hash className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <div className="flex flex-wrap gap-1 min-w-0">
            {task.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-5">
                {tag}
              </Badge>
            ))}
            {task.tags.length > 3 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">+{task.tags.length - 3}</Badge>
            )}
          </div>
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
        isDragging && "opacity-50 !bg-gray-100 dark:!bg-gray-800 !border-transparent",
        onClick && "cursor-pointer"
      )}
    >
      {isDragging ? <div className="invisible">{cardContent}</div> : cardContent}
    </div>
  );
}

// ---------- ColumnHeader ----------

function ColumnHeader({ column, taskCount, onAddTask }: { column: PipelineColumn; taskCount: number; onAddTask: () => void }) {
  return (
    <div className="mb-0">
      <div className="flex items-center justify-between mb-1 rounded-md px-2 py-1 -mx-2 transition-colors group hover:bg-gray-100 dark:hover:bg-secondary">
        <div className="flex items-center gap-2 ml-1">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: column.color }} />
          <h3 className="font-medium text-sm text-gray-900 dark:text-foreground">{column.name}</h3>
          <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px]">
            {taskCount}
          </span>
        </div>
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

export function MyTasksPipeline({
  tasks,
  availableLabels,
  filterConfigs,
  onTaskClick,
  onStatusChange,
  onReorder,
  onCreateTask,
  viewToggle,
}: MyTasksPipelineProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  const columns = useMemo<PipelineColumn[]>(() => [
    { id: 'backlog', name: t.projects.myTasks.pipeline.backlog, color: columnColors.backlog },
    { id: 'todo', name: t.projects.myTasks.pipeline.todo, color: columnColors.todo },
    { id: 'in_progress', name: t.projects.myTasks.pipeline.inProgress, color: columnColors.in_progress },
    { id: 'in_review', name: t.projects.myTasks.pipeline.inReview, color: columnColors.in_review },
    { id: 'testing', name: t.projects.myTasks.pipeline.testing, color: columnColors.testing },
    { id: 'done', name: t.projects.myTasks.pipeline.done, color: columnColors.done },
    { id: 'cancelled', name: t.projects.myTasks.pipeline.cancelled, color: columnColors.cancelled },
  ], [t]);

  const priorityConfig = useMemo<Record<string, { label: string; color: string; bg: string }>>(() => ({
    low: { label: t.projects.myTasks.priorityLabels.low, ...priorityConfigBase.low },
    medium: { label: t.projects.myTasks.priorityLabels.medium, ...priorityConfigBase.medium },
    high: { label: t.projects.myTasks.priorityLabels.high, ...priorityConfigBase.high },
    urgent: { label: t.projects.myTasks.priorityLabels.urgent, ...priorityConfigBase.urgent },
    critical: { label: t.projects.myTasks.priorityLabels.critical, ...priorityConfigBase.critical },
  }), [t]);

  // Drag state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [draggedTaskOriginalStatus, setDraggedTaskOriginalStatus] = useState<{ id: string; status: string } | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filters
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  // Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } })
  );

  // Collision detection: prefer task items over stage containers
  // so within-column reorder detects the specific task being dragged over
  const customCollisionDetection = useCallback((args: any) => {
    const pointerCollisions = pointerWithin(args);
    // Prefer task item collisions for within-column reorder
    const taskCollisions = pointerCollisions.filter((c: any) => !c.id?.toString().startsWith('stage-'));
    if (taskCollisions.length > 0) return taskCollisions;
    // Fall back to stage collisions for cross-column drag
    const stageCollisions = pointerCollisions.filter((c: any) => c.id?.toString().startsWith('stage-'));
    if (stageCollisions.length > 0) return stageCollisions;
    // Final fallback
    const rectCollisions = rectIntersection(args);
    const rectStageCollisions = rectCollisions.filter((c: any) => c.id?.toString().startsWith('stage-'));
    if (rectStageCollisions.length > 0) return rectStageCollisions;
    return rectCollisions;
  }, []);

  // Filter + search
  const filteredTasks = useMemo(() => {
    let result = tasks;

    // Search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(t =>
        t.title.toLowerCase().includes(query) ||
        t.description?.toLowerCase().includes(query) ||
        t.assignee?.toLowerCase().includes(query) ||
        t.project?.toLowerCase().includes(query)
      );
    }

    // Apply filters
    if (activeFilters.length > 0) {
      for (const filter of activeFilters) {
        if (!filter.operator || !filter.value) continue;
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
        }
      }
    }

    return result;
  }, [tasks, searchQuery, activeFilters]);

  // Drag handlers
  const handleDragStart = (event: DragStartEvent) => {
    const activeId = event.active.id as string;
    setActiveDragId(activeId);
    const task = tasks.find(t => t.id === activeId);
    if (task) {
      setDraggedTaskOriginalStatus({ id: task.id, status: task.status });
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { over } = event;
    setActiveDragId(null);

    if (!over || !draggedTaskOriginalStatus) {
      setDraggedTaskOriginalStatus(null);
      return;
    }

    const overId = over.id as string;
    let targetStatus: string | undefined;

    if (overId.startsWith('stage-')) {
      targetStatus = overId.replace('stage-', '');
    } else {
      // Dropped on another task â€” find which column it belongs to
      const overTask = tasks.find(t => t.id === overId);
      if (overTask) targetStatus = overTask.status;
    }

    if (targetStatus && targetStatus !== draggedTaskOriginalStatus.status) {
      // Cross-column: change status
      onStatusChange(draggedTaskOriginalStatus.id, targetStatus as Task['status']);
    } else if (targetStatus && targetStatus === draggedTaskOriginalStatus.status && !overId.startsWith('stage-') && onReorder) {
      // Within-column reorder
      const columnTasks = filteredTasks.filter(t => t.status === targetStatus);
      const oldIndex = columnTasks.findIndex(t => t.id === draggedTaskOriginalStatus.id);
      const newIndex = columnTasks.findIndex(t => t.id === overId);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reorderedIds = arrayMove(columnTasks.map(t => t.id), oldIndex, newIndex);
        onReorder(targetStatus as Task['status'], reorderedIds);
      }
    }

    setDraggedTaskOriginalStatus(null);
  };

  const activeTask = activeDragId ? tasks.find(t => t.id === activeDragId) : null;

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0">
        <div className="flex items-center justify-between px-4 h-[53px] border-b border-gray-200 dark:border-border">
          <div className="flex items-center gap-2">
            <FilterPills
              filters={activeFilters}
              filterConfigs={filterConfigs}
              maxFilters={5}
              onFiltersChange={setActiveFilters}
            />
            {viewToggle}
          </div>
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative flex items-center">
              <div className={cn("flex items-center transition-all duration-200 ease-out", searchOpen ? "w-48" : "w-8")}>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200", searchOpen && "opacity-0 pointer-events-none absolute")}
                  onClick={() => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 100); }}
                >
                  <Search className="h-4 w-4" />
                </Button>
                <div className={cn("relative transition-all duration-200 ease-out", searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none")}>
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder={t.projects.myTasks.pipeline.searchPlaceholder}
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
              onClick={() => onCreateTask()}
            >
              <Plus className="h-4 w-4 mr-0.5" />
              <span>{t.projects.myTasks.pipeline.newTask}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 flex flex-col overflow-hidden select-none">
        <DndContext sensors={sensors} collisionDetection={customCollisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div
            className="flex gap-4 flex-1 overflow-x-auto overflow-y-visible gantt-scroll pb-0"
            style={{ padding: '16px 16px' }}
          >
            {columns.map((column) => {
              const columnTasks = filteredTasks.filter(t => t.status === column.id);
              return (
                <div key={column.id} className="flex-shrink-0 w-[240px] relative overflow-visible">
                  <div className="flex flex-col h-full overflow-visible">
                    <DroppableColumn id={column.id} containerRef={containerRef}>
                      <div className="flex flex-col h-full">
                        <ColumnHeader
                          column={column}
                          taskCount={columnTasks.length}
                          onAddTask={() => onCreateTask(column.id)}
                        />
                        <div className="flex-1 flex flex-col">
                          <div className="space-y-2">
                            <SortableContext items={columnTasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
                              {columnTasks.map((task) => (
                                <TaskCard
                                  key={task.id}
                                  task={task}
                                  availableLabels={availableLabels}
                                  priorityConfig={priorityConfig}
                                  unassignedLabel={t.projects.myTasks.unassigned}
                                  onClick={() => onTaskClick(task)}
                                />
                              ))}
                            </SortableContext>
                          </div>
                          {columnTasks.length === 0 && (
                            <Button
                              variant="ghost"
                              className="w-full h-auto py-2 px-4 bg-gray-50 dark:bg-background/50 border border-dashed border-gray-200 dark:border-border rounded-lg text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-background flex items-center justify-center gap-2 text-sm font-medium"
                              onClick={() => onCreateTask(column.id)}
                            >
                              <Plus className="h-4 w-4" />
                              {t.projects.myTasks.pipeline.newTask}
                            </Button>
                          )}
                          <div className="flex-1 min-h-[200px]" />
                        </div>
                      </div>
                    </DroppableColumn>
                  </div>
                </div>
              );
            })}
          </div>

          <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
            {activeTask ? (
              <div className="rotate-3 scale-105">
                <div className="bg-white dark:bg-background rounded-lg border border-gray-125 dark:border-border p-3 w-[240px] shadow-lg">
                  <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate block">{activeTask.title}</span>
                  {activeTask.assignee && (
                    <div className="flex items-center gap-2 mt-2">
                      <Avatar className="h-4 w-4 rounded">
                        <AvatarFallback className="text-[9px] bg-cyan-500 text-white rounded">
                          {activeTask.assignee.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm text-gray-600 dark:text-muted-foreground">{activeTask.assignee}</span>
                    </div>
                  )}
                  {activeTask.dueDate && (
                    <div className="flex items-center gap-2 mt-2">
                      <Calendar className="h-3.5 w-3.5 text-gray-400" />
                      <span className="text-sm text-gray-600 dark:text-muted-foreground">{shortDateFormatter.format(activeTask.dueDate)}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
