
import { useState, useEffect } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { NewTaskModal } from './new-task-modal';
import { useObjectPanel } from '@/components/object-panel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Plus,
  Search,
  MoreVertical,
  Calendar,
  Filter,
  User,
  Building2,
  Columns,
  CheckCircle2
} from 'lucide-react';
import { format, isToday, isTomorrow, isPast, addDays, isThisWeek, isThisMonth } from 'date-fns';
import { cn } from '@/lib/utils';
import { TagLabel } from '@/components/weldflow/tag-label';
import { TaskNumberBadge } from '@/components/weldflow/task-number-badge';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { labelsApi } from '@/app/weldflow/lib/api-client';
import { useTranslations } from '@weldsuite/i18n/client';

interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

interface Task {
  id: string;
  number?: number | null;
  title: string;
  description?: string;
  completed: boolean;
  status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'testing' | 'done' | 'cancelled';
  assignee?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  linkedCompany?: {
    id: string;
    name: string;
    logoUrl?: string;
    color?: string;
  };
  dueDate?: Date;
  createdAt: Date;
  labels?: string[];
}

interface TasksViewProps {
  projectId?: string;
  initialTasks?: any[];
}

export function TasksView({ projectId, initialTasks = [] }: TasksViewProps) {
  const st = useTranslations();
  const { getClient } = useAppApiClient();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false);
  const [availableLabels, setAvailableLabels] = useState<ProjectLabel[]>([]);
  const { open: openObjectPanel } = useObjectPanel();

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

  const handleCreateLabel = async (data: { name: string; color: string }): Promise<ProjectLabel | null> => {
    const result = await labelsApi.create({ ...data, projectId });
    if (result.success && result.data) {
      const newLabel: ProjectLabel = { id: result.data.id, name: data.name, color: data.color };
      setAvailableLabels(prev => [newLabel, ...prev]);
      return newLabel;
    }
    return null;
  };

  // Transform API tasks to component format
  const transformApiTasks = (apiTasks: any[]): Task[] => {
    return apiTasks.map((task: any) => ({
      id: task.id,
      number: task.number ?? null,
      title: task.title,
      description: task.description,
      completed: task.status === 'done' || task.status === 'completed',
      status: task.status?.toLowerCase() as 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'testing' | 'done' | 'cancelled' || 'todo',
      assignee: task.assignee ? {
        id: task.assignee.id || task.assigneeId,
        name: task.assignee.name || 'Unknown',
        avatarUrl: task.assignee.avatarUrl,
      } : undefined,
      linkedCompany: task.company ? {
        id: task.company.id,
        name: task.company.name,
        logoUrl: task.company.logoUrl,
        color: task.company.color || '#6B7280',
      } : undefined,
      dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
      createdAt: new Date(task.createdAt),
      labels: task.labels || [],
    }));
  };

  // Initialize from server-side data
  useEffect(() => {
    if (initialTasks.length > 0) {
      const transformedTasks = transformApiTasks(initialTasks);
      setTasks(transformedTasks);
    }
  }, [initialTasks]);

  // Refetch tasks from API.
  // The old `/weldflow/*` paths never existed (api-worker mounts no weldflow routes);
  // the canonical surface is `/api/tasks`, scoped with `?projectId=`.
  const refetchTasks = async () => {
    try {
      const client = await getClient();
      const path = projectId ? `/tasks?projectId=${projectId}` : '/tasks';
      const result = await client.get<{
        data: any[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(path);

      const transformedTasks = transformApiTasks(result.data ?? []);
      setTasks(transformedTasks);
    } catch (error) {
      console.error('Failed to refetch tasks:', error);
    }
  };

  // Filter tasks
  const filteredTasks = tasks.filter(task => {
    const matchesSearch = 
      task.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.linkedCompany?.name.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesCompleted = showCompleted || !task.completed;
    
    return matchesSearch && matchesCompleted;
  });

  // Group tasks by date
  const overdueTasks = filteredTasks.filter(t => 
    !t.completed && t.dueDate && isPast(t.dueDate) && !isToday(t.dueDate)
  );
  const todayTasks = filteredTasks.filter(t => 
    !t.completed && t.dueDate && isToday(t.dueDate)
  );
  const tomorrowTasks = filteredTasks.filter(t => 
    !t.completed && t.dueDate && isTomorrow(t.dueDate)
  );
  const thisWeekTasks = filteredTasks.filter(t => 
    !t.completed && t.dueDate && isThisWeek(t.dueDate) && !isToday(t.dueDate) && !isTomorrow(t.dueDate)
  );
  const laterTasks = filteredTasks.filter(t => 
    !t.completed && t.dueDate && !isThisWeek(t.dueDate)
  );
  const noDateTasks = filteredTasks.filter(t => 
    !t.completed && !t.dueDate
  );
  const completedTasks = filteredTasks.filter(t => t.completed);

  const toggleTask = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    try {
      const client = await getClient();
      // `PATCH /api/tasks/:id/toggle { currentStatus }` — same contract the
      // useCompleteTask / useUncompleteTask hooks already use.
      await client.patch<{ data: { id: string; status: string } }>(
        `/tasks/${taskId}/toggle`,
        { currentStatus: task.status || 'todo' }
      );
      await refetchTasks();
    } catch (error) {
      console.error('Failed to toggle task:', error);
      toast.error(st('sweep.weldflow.tasksView.updateFailed'));
    }
  };

  const deleteTask = async (taskId: string) => {
    try {
      const client = await getClient();
      // 204 No Content on success; the client throws on anything else.
      await client.delete<void>(`/tasks/${taskId}`);
      await refetchTasks();
      toast.success(st('sweep.weldflow.tasksView.deletedSuccessfully'));
    } catch (error) {
      console.error('Failed to delete task:', error);
      toast.error(st('sweep.weldflow.tasksView.deleteFailed'));
    }
  };

  const addTask = async (newTask: Task) => {
    try {
      const client = await getClient();
      await client.post<{ data: any }>('/tasks', {
        projectId: projectId,
        title: newTask.title,
        description: newTask.description,
        status: newTask.status || 'todo',
        priority: 'medium',
        dueDate: newTask.dueDate ? newTask.dueDate.toISOString() : undefined,
      });
      await refetchTasks();
      toast.success(st('sweep.weldflow.tasksView.createdSuccessfully'));
    } catch (error) {
      console.error('Failed to create task:', error);
      toast.error(st('sweep.weldflow.tasksView.createFailed'));
    }
  };

  const updateTask = async (updatedTask: Task) => {
    try {
      const client = await getClient();
      await client.patch<{ data: any }>(
        `/tasks/${updatedTask.id}`,
        {
          title: updatedTask.title,
          description: updatedTask.description,
          status: updatedTask.status,
          dueDate: updatedTask.dueDate ? updatedTask.dueDate.toISOString() : undefined,
        }
      );
      await refetchTasks();
      toast.success(st('sweep.weldflow.tasksView.updatedSuccessfully'));
    } catch (error) {
      console.error('Failed to update task:', error);
      toast.error(st('sweep.weldflow.tasksView.updateFailed'));
    }
  };

  const handleTaskClick = (task: Task) => {
    openObjectPanel({ type: 'task', id: task.id });
  };

  const getInitials = (name: string) => {
    if (!name) return '?';
    return name.charAt(0).toUpperCase();
  };

  const TaskItem = ({ task }: { task: Task }) => {
    const isOverdue = task.dueDate && isPast(task.dueDate) && !isToday(task.dueDate);

    const getStatusLabel = (status?: string) => {
      switch (status) {
        case 'backlog':
          return 'Backlog';
        case 'todo':
          return 'To Do';
        case 'in_progress':
          return 'In Progress';
        case 'in_review':
          return 'In Review';
        case 'testing':
          return 'Testing';
        case 'done':
          return 'Done';
        case 'cancelled':
          return 'Cancelled';
        default:
          return null;
      }
    };

    const statusLabel = getStatusLabel(task.status);

    return (
      <div
        className="group flex items-center gap-3 py-2.5 px-3 -mx-3 hover:bg-gray-50 dark:hover:bg-background/50 rounded-lg transition-colors cursor-pointer"
        onClick={() => handleTaskClick(task)}
      >
        <Checkbox
          checked={task.completed}
          onCheckedChange={(checked) => {
            toggleTask(task.id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 shadow-none"
        />

        <div className="flex-1 flex items-center gap-3">
          {task.number != null && (
            <TaskNumberBadge number={task.number} className="flex-shrink-0" />
          )}
          <span className={cn(
            "text-sm",
            task.completed && "line-through text-gray-400"
          )}>
            {task.title}
          </span>
          {task.labels && task.labels.length > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {task.labels.map(labelId => {
                const label = availableLabels.find(l => l.id === labelId);
                if (!label) return null;
                return (
                  <span
                    key={labelId}
                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
                    style={{ backgroundColor: label.color }}
                  >
                    {label.name}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-32">
          {/* Company - fixed width */}
          <div className="w-32">
            {task.linkedCompany && (
              <Button
                variant="ghost"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1.5 hover:bg-gray-100 dark:hover:bg-secondary px-2 py-0.5 -mx-2 rounded transition-colors"
              >
                <div
                  className="h-3 w-3 rounded-sm"
                  style={{ backgroundColor: task.linkedCompany.color || '#6B7280' }}
                />
                <span className="text-xs text-gray-600 dark:text-muted-foreground">
                  {task.linkedCompany.name}
                </span>
              </Button>
            )}
          </div>

          {/* Status - fixed width */}
          <div className="w-24">
            {statusLabel && (
              <TagLabel tag={statusLabel} />
            )}
          </div>

          {/* Due - fixed width */}
          <div className="w-24">
            {task.dueDate && (
              <div className={cn(
                "flex items-center gap-1 text-xs",
                isOverdue ? "text-red-600" : "text-gray-500"
              )}>
                <Calendar className="h-3 w-3" />
                {isToday(task.dueDate) ? 'Today' :
                 isTomorrow(task.dueDate) ? 'Tomorrow' :
                 format(task.dueDate, 'MMM d')}
              </div>
            )}
          </div>

          {/* Assignee - fixed width */}
          <div className="w-6">
            {task.assignee && (
              <Avatar className="h-6 w-6 rounded-sm">
                <AvatarImage src={task.assignee.avatarUrl} />
                <AvatarFallback className="text-[9px] bg-gray-100 dark:bg-secondary rounded-sm">
                  {getInitials(task.assignee.name)}
                </AvatarFallback>
              </Avatar>
            )}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => e.stopPropagation()}
                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <MoreVertical className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>{st('sweep.weldflow.edit')}</DropdownMenuItem>
              <DropdownMenuItem>{st('sweep.weldflow.notesView.duplicate')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600"
                onClick={() => deleteTask(task.id)}
              >
                {st('sweep.weldflow.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const TaskSection = ({ title, tasks, count, showDivider = true }: {
    title: string;
    tasks: Task[];
    count?: number;
    showDivider?: boolean;
  }) => {
    if (tasks.length === 0) return null;

    return (
      <>
        <div className="mb-10">
          {/* Title row */}
          <h2 className="text-sm font-medium text-gray-600 dark:text-muted-foreground mb-2 flex items-center gap-2">
            {title}
            {(count !== undefined || tasks.length > 0) && (
              <span className="bg-gray-100 dark:bg-secondary rounded-sm text-xs w-5 h-5 flex items-center justify-center">
                {count !== undefined ? count : tasks.length}
              </span>
            )}
          </h2>

          <div className="space-y-0.5">
            {tasks.map(task => (
              <TaskItem key={task.id} task={task} />
            ))}
          </div>
        </div>
        {showDivider && <hr className="border-gray-200 dark:border-border mb-8" />}
      </>
    );
  };

  // Stats
  const totalTasks = tasks.filter(t => !t.completed).length;
  const completedCount = tasks.filter(t => t.completed).length;

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{st('sweep.weldflow.tasksView.title')}</h1>
            <div className="flex items-center gap-6 mt-3">
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="font-medium">{completedCount}</span> {st('sweep.weldflow.tasksView.completed')}
                </span>
                <span className="text-muted-foreground">•</span>
                <span className="flex items-center gap-1">
                  <div className="h-4 w-4 rounded-full border-2 border-gray-400" />
                  <span className="font-medium">{totalTasks}</span> {st('sweep.weldflow.tasksView.todo')}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <Columns className="h-3.5 w-3.5" />
              </Button>
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                    <Filter className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => setShowCompleted(!showCompleted)}>
                    {showCompleted ? st('sweep.weldflow.tasksView.hideCompletedTasks') : st('sweep.weldflow.tasksView.showCompletedTasks')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>
                    <User className="h-3.5 w-3.5 mr-2" />
                    {st('sweep.weldflow.tasksView.myTasks')}
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Building2 className="h-3.5 w-3.5 mr-2" />
                    {st('sweep.weldflow.notesView.byCompany')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
              <Input
                type="text"
                placeholder={st('sweep.weldflow.tasksView.searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-8 pl-8 pr-3 w-[200px]"
              />
            </div>

            <Button 
              size="sm" 
              className="h-8"
              onClick={() => setIsNewTaskModalOpen(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-0.5" />
              {st('sweep.weldflow.tasksView.newTask')}
            </Button>
          </div>
        </div>

        {/* Task List */}
        <div className="mt-8">
          {/* Today section title with column headers */}
          {todayTasks.length > 0 && (
            <>
              <div className="flex items-center gap-3 py-2 px-3 -mx-3 mb-3">
                {/* Today title */}
                <h2 className="text-sm font-medium text-gray-600 dark:text-muted-foreground flex items-center gap-2">
                  {st('sweep.weldflow.notesView.today')}
                  <span className="bg-gray-100 dark:bg-secondary rounded-sm text-xs w-5 h-5 flex items-center justify-center">
                    {todayTasks.length}
                  </span>
                </h2>

                {/* Column header labels */}
                <div className="flex-1 flex items-center gap-3 text-sm font-medium text-gray-500 dark:text-muted-foreground">
                  <div className="h-4 w-4"></div> {/* Checkbox space */}
                  <div className="flex-1"></div> {/* Task title space */}
                  <div className="flex items-center gap-32">
                    <span className="w-32">{st('sweep.weldflow.newTaskModal.company')}</span>
                    <span className="w-24">{st('sweep.weldflow.tasksView.status')}</span>
                    <span className="w-24">{st('sweep.weldflow.tasksView.due')}</span>
                    <span className="w-6">{st('sweep.weldflow.newTaskModal.assignee')}</span>
                    <span className="w-6"></span> {/* Menu button space */}
                  </div>
                </div>
              </div>

              {/* Horizontal line under headers */}
              <hr className="border-gray-200 dark:border-border mb-2" />

              {/* Today tasks */}
              <div className="space-y-0.5 mb-10">
                {todayTasks.map(task => (
                  <TaskItem key={task.id} task={task} />
                ))}
              </div>
            </>
          )}
          {overdueTasks.length > 0 && (
            <TaskSection
              title={st('sweep.weldflow.tasksView.overdue')}
              tasks={overdueTasks}
              showDivider={false}
            />
          )}
          {tomorrowTasks.length > 0 && (
            <TaskSection
              title={st('sweep.weldflow.tasksView.tomorrow')}
              tasks={tomorrowTasks}
              showDivider={false}
            />
          )}
          {thisWeekTasks.length > 0 && (
            <TaskSection
              title={st('sweep.weldflow.notesView.thisWeek')}
              tasks={thisWeekTasks}
              showDivider={false}
            />
          )}
          {laterTasks.length > 0 && (
            <TaskSection
              title={st('sweep.weldflow.tasksView.later')}
              tasks={laterTasks}
              showDivider={false}
            />
          )}
          {noDateTasks.length > 0 && (
            <TaskSection
              title={st('sweep.weldflow.tasksView.noDate')}
              tasks={noDateTasks}
              showDivider={false}
            />
          )}
          {showCompleted && completedTasks.length > 0 && (
            <TaskSection
              title={st('sweep.weldflow.tasksView.completedTitle')}
              tasks={completedTasks}
              count={completedCount}
              showDivider={false}
            />
          )}

          {filteredTasks.length === 0 && (
            <div className="text-center py-12">
              <p className="text-gray-500">{st('sweep.weldflow.tasksView.noTasksFound')}</p>
              <p className="text-sm text-gray-400 mt-1">
                {st('sweep.weldflow.tasksView.noTasksFoundDesc')}
              </p>
            </div>
          )}
        </div>
      </div>
      
      {/* New Task Modal */}
      <NewTaskModal
        isOpen={isNewTaskModalOpen}
        onClose={() => setIsNewTaskModalOpen(false)}
        onSave={addTask}
      />

    </div>
  );
}