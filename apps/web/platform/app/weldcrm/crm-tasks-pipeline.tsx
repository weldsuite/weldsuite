
import { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
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
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@weldsuite/ui/components/button';
import { Plus, Calendar, Search, Repeat2, User } from 'lucide-react';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { TaskNumberBadge } from '@/components/weldflow/task-number-badge';
import { FilterPills } from '@/components/entity-list';
import type { FilterConfig, ActiveFilter } from '@/components/entity-list';
import type { Task } from '@/hooks/use-crm-tasks';

// ---------- Types ----------

interface PipelineColumn {
  id: Task['status'];
  name: string;
  color: string;
}

interface CrmTasksPipelineProps {
  tasks: Task[];
  filterConfigs: FilterConfig[];
  onTaskClick: (task: Task) => void;
  onStatusChange: (taskId: string, newStatus: Task['status']) => void;
  onCreateTask: (status?: Task['status']) => void;
  viewToggle: React.ReactNode;
  statusLabels: Record<Task['status'], string>;
  priorityLabels: Record<string, string>;
  searchPlaceholder: string;
  newTaskLabel: string;
}

// ---------- Constants ----------

const priorityColors: Record<string, string> = {
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  low: 'bg-gray-100 text-gray-700 dark:bg-secondary dark:text-muted-foreground',
};

const shortDateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

// ---------- DroppableColumn ----------

function DroppableColumn({ id, children, containerRef }: { id: string; children: React.ReactNode; containerRef?: React.RefObject<HTMLDivElement | null> }) {
  const { isOver, setNodeRef } = useDroppable({ id: `stage-${id}` });
  const stageRef = useRef<HTMLDivElement>(null);
  const [overlayStyle, setOverlayStyle] = useState<React.CSSProperties>({});

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

function TaskCard({ task, priorityLabels, onClick }: { task: Task; priorityLabels: Record<string, string>; onClick?: () => void }) {
  const t = useTranslations();
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
      {/* Task number */}
      {task.number != null && (
        <div className="mb-1">
          <TaskNumberBadge number={task.number} />
        </div>
      )}

      {/* Title */}
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate block">
          {task.title}
        </span>
        {task.repeat && (
          <Repeat2 className="h-3 w-3 text-indigo-500 flex-shrink-0" />
        )}
      </div>

      {/* Company */}
      {task.linkedCompany && (
        <div className="mt-1.5">
          <span className="text-xs text-gray-500 dark:text-muted-foreground truncate block">
            {task.linkedCompany.name}
          </span>
        </div>
      )}

      {/* Assignee */}
      <div className="flex items-center gap-2 mt-2">
        {task.assignee ? (
          <>
            <div className="w-4 h-4 rounded bg-orange-100 flex items-center justify-center flex-shrink-0">
              <User className="w-2.5 h-2.5 text-orange-600" />
            </div>
            <span className="text-sm text-gray-600 dark:text-muted-foreground truncate">
              {task.assignee.name}
            </span>
          </>
        ) : (
          <>
            <Avatar className="h-4 w-4 rounded">
              <AvatarFallback className="text-[9px] bg-gray-100 text-gray-400 dark:bg-secondary dark:text-muted-foreground rounded">
                ?
              </AvatarFallback>
            </Avatar>
            <span className="text-sm text-gray-600 dark:text-muted-foreground truncate">
              {t('crm.taskDialog.unassigned')}
            </span>
          </>
        )}
      </div>

      {/* Priority */}
      {task.priority && (
        <div className="mt-2">
          <Badge
            variant="secondary"
            className={cn(
              'font-semibold text-[11px] px-1.5 py-0 border-0 rounded-sm',
              priorityColors[task.priority] || 'bg-gray-100 text-gray-700 dark:bg-secondary dark:text-muted-foreground'
            )}
          >
            {priorityLabels[task.priority] || task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
          </Badge>
        </div>
      )}

      {/* Due Date */}
      {task.dueDate && (
        <div className="flex items-center gap-2 mt-2">
          <Calendar className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {shortDateFormatter.format(task.dueDate)}
          </span>
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

export function CrmTasksPipeline({
  tasks,
  filterConfigs,
  onTaskClick,
  onStatusChange,
  onCreateTask,
  viewToggle,
  statusLabels,
  priorityLabels,
  searchPlaceholder,
  newTaskLabel,
}: CrmTasksPipelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const columns: PipelineColumn[] = useMemo(() => [
    { id: 'backlog', name: statusLabels['backlog'], color: '#94a3b8' },
    { id: 'todo', name: statusLabels['todo'], color: '#c4b5fd' },
    { id: 'in_progress', name: statusLabels['in_progress'], color: '#93c5fd' },
    { id: 'in_review', name: statusLabels['in_review'], color: '#fcd34d' },
    { id: 'testing', name: statusLabels['testing'], color: '#a78bfa' },
    { id: 'done', name: statusLabels['done'], color: '#5eead4' },
    { id: 'cancelled', name: statusLabels['cancelled'], color: '#f87171' },
  ], [statusLabels]);

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

  // Collision detection: prefer stage droppables
  const customCollisionDetection = useCallback((args: any) => {
    const pointerCollisions = pointerWithin(args);
    const stageCollisions = pointerCollisions.filter((c: any) => c.id?.toString().startsWith('stage-'));
    if (stageCollisions.length > 0) return stageCollisions;
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
        t.assignee?.name?.toLowerCase().includes(query) ||
        t.linkedCompany?.name?.toLowerCase().includes(query)
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
        } else if (filter.field === 'company') {
          result = filter.operator === 'is'
            ? result.filter(t => t.linkedCompany?.name === filter.value)
            : result.filter(t => t.linkedCompany?.name !== filter.value);
        } else if (filter.field === 'assignee') {
          result = filter.operator === 'is'
            ? result.filter(t => t.assignee?.name === filter.value)
            : result.filter(t => t.assignee?.name !== filter.value);
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
      const overTask = tasks.find(t => t.id === overId);
      if (overTask) targetStatus = overTask.status;
    }

    if (targetStatus && targetStatus !== draggedTaskOriginalStatus.status) {
      onStatusChange(draggedTaskOriginalStatus.id, targetStatus as Task['status']);
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
                    placeholder={searchPlaceholder}
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
              <span>{newTaskLabel}</span>
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
                                  priorityLabels={priorityLabels}
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
                              {newTaskLabel}
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
                      <div className="w-4 h-4 rounded bg-orange-100 flex items-center justify-center">
                        <User className="w-2.5 h-2.5 text-orange-600" />
                      </div>
                      <span className="text-sm text-gray-600 dark:text-muted-foreground">{activeTask.assignee.name}</span>
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
