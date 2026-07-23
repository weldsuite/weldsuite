
import { useState, useMemo, useCallback } from 'react';
import { useUser } from '@clerk/clerk-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  CheckCircle2,
  User,
  Trash2,
  Check,
  Repeat2,
  EllipsisVertical,
  Pencil,
  Copy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useCrmTasks,
  useCreateTask,
  useToggleTask,
  useUpdateTask,
  useDeleteTask,
  type Task,
} from '@/hooks/use-crm-tasks';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type RowHandlers } from '@/components/entity-list';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { useObjectPanel } from '@/components/object-panel';
import { useCustomerDetailContext } from '../customer-detail-provider';
import type { TasksSectionProps } from '../types';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { useTranslations } from '@weldsuite/i18n/client';

export function TasksSection({ customer }: TasksSectionProps) {
  const t = useTranslations();
  const { mode, isExpanded } = useCustomerDetailContext();

  // Status configuration — matches the canonical pill colors used across the
  // WeldFlow tasks page (apps/web/platform/app/weldflow/project/[projectId]/tasks).
  const statusConfig: Record<string, { label: string; color: string; bg: string }> = useMemo(() => ({
    'backlog': { label: t('sweep.weldcrm.tasksSection.statusBacklog'), color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-900/50' },
    'todo': { label: t('sweep.weldcrm.tasksSection.statusTodo'), color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    'in_progress': { label: t('sweep.weldcrm.tasksSection.statusInProgress'), color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    'in_review': { label: t('sweep.weldcrm.tasksSection.statusInReview'), color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
    'testing': { label: t('sweep.weldcrm.tasksSection.statusTesting'), color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
    'done': { label: t('sweep.weldcrm.tasksSection.statusDone'), color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
    'cancelled': { label: t('sweep.weldcrm.tasksSection.statusCancelled'), color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  }), [t]);

  // Priority configuration — same canonical pattern.
  const priorityConfig: Record<string, { label: string; color: string; bg: string }> = useMemo(() => ({
    'low': { label: t('sweep.weldcrm.tasksSection.priorityLow'), color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    'medium': { label: t('sweep.weldcrm.tasksSection.priorityMedium'), color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    'high': { label: t('sweep.weldcrm.tasksSection.priorityHigh'), color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  }), [t]);

  // Due date configuration
  const dueDateConfig = useMemo(() => ({
    'overdue': { label: t('sweep.weldcrm.tasksSection.dueOverdue') },
    'today': { label: t('sweep.weldcrm.notesView.today') },
    'tomorrow': { label: t('sweep.weldcrm.tasksSection.dueTomorrow') },
    'this-week': { label: t('sweep.weldcrm.callsSection.thisWeek') },
    'later': { label: t('sweep.weldcrm.tasksSection.dueLater') },
    'no-date': { label: t('sweep.weldcrm.tasksSection.noDueDate') },
  }), [t]);
  // Compact panel (~500px) uses a stripped layout; expanded panel matches the page route.
  const isPanel = (mode === 'panel' && !isExpanded) || mode === 'embedded';
  const { user } = useUser();
  const { data: tasks = [], isLoading, error } = useCrmTasks(user?.id);
  const { data: membersData } = useWorkspaceMembers(1, 100);
  // Lookup map: name → avatar URL. Used to render real avatars in the
  // assignee column (CRM Task type only carries name/id, not avatar).
  const memberAvatarByName = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const m of (membersData?.data ?? []) as any[]) {
      if (m?.name) map.set(m.name, m.picture || undefined);
    }
    return map;
  }, [membersData]);
  const createTaskMutation = useCreateTask();
  const toggleTaskMutation = useToggleTask();
  const updateTaskMutation = useUpdateTask();
  const deleteTaskMutation = useDeleteTask();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [groupBy, setGroupBy] = useState<'status' | 'priority' | 'dueDate' | 'assignee' | 'none'>('dueDate');
  const { open: openObjectPanel } = useObjectPanel();

  // Memoize available assignees for filters and dialog
  const availableAssignees = useMemo(() =>
    Array.from(new Set(tasks.map(t => t.assignee?.name).filter(Boolean))) as string[],
    [tasks]
  );

  const customerDisplayName =
    customer.companyName ||
    customer.tradingName ||
    customer.fullName ||
    [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() ||
    customer.email ||
    '';

  const availableCompanies = useMemo(() => {
    const names = new Set<string>();
    tasks.forEach((t) => {
      if (t.linkedCompany?.name) names.add(t.linkedCompany.name);
    });
    if (customerDisplayName) names.add(customerDisplayName);
    return Array.from(names);
  }, [tasks, customerDisplayName]);

  // Filter configurations (no company filter since we're in customer context)
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: t('sweep.weldcrm.callsSection.status'),
      options: Object.entries(statusConfig).map(([key, config]) => ({ value: key, label: config.label })),
      getDisplayValue: (value) => statusConfig[value as keyof typeof statusConfig]?.label || value,
    },
    {
      field: 'priority',
      label: t('sweep.weldcrm.tasksSection.priority'),
      options: Object.entries(priorityConfig).map(([key, config]) => ({ value: key, label: config.label })),
      getDisplayValue: (value) => priorityConfig[value as keyof typeof priorityConfig]?.label || value,
    },
    {
      field: 'due date',
      label: t('sweep.weldcrm.tasksSection.dueDate'),
      options: Object.entries(dueDateConfig).map(([key, config]) => ({ value: key, label: config.label })),
      getDisplayValue: (value) => dueDateConfig[value as keyof typeof dueDateConfig]?.label || value,
    },
    {
      field: 'assignee',
      label: t('sweep.weldcrm.tasksSection.assignee'),
      options: availableAssignees.map(name => ({ value: name, label: name })),
    },
  ], [availableAssignees, t, statusConfig, priorityConfig, dueDateConfig]);

  // Group configurations — driven by the `groupBy` selector. `none` returns
  // an empty array so EntityList renders a single flat list.
  const groupConfigs: GroupConfig<Task>[] = useMemo(() => {
    if (groupBy === 'none') return [];
    if (groupBy === 'status') {
      return Object.entries(statusConfig).map(([key, cfg], idx) => ({
        id: `status-${key}`,
        label: cfg.label,
        sortOrder: idx + 1,
        filter: (t) => t.status === key,
      }));
    }
    if (groupBy === 'priority') {
      return Object.entries(priorityConfig).map(([key, cfg], idx) => ({
        id: `priority-${key}`,
        label: cfg.label,
        sortOrder: idx + 1,
        filter: (t) => (t.priority ?? 'medium') === key,
      }));
    }
    if (groupBy === 'assignee') {
      const groups: GroupConfig<Task>[] = availableAssignees.map((name, idx) => ({
        id: `assignee-${name}`,
        label: name,
        sortOrder: idx + 1,
        filter: (t) => t.assignee?.name === name,
      }));
      groups.push({
        id: 'unassigned',
        label: t('sweep.weldcrm.tasksSection.unassigned'),
        sortOrder: availableAssignees.length + 1,
        filter: (t) => !t.assignee,
      });
      return groups;
    }
    // dueDate (default)
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    const startOfDayAfterTomorrow = new Date(startOfToday.getTime() + 2 * 24 * 60 * 60 * 1000);
    const endOfWeek = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
    return [
      { id: 'overdue', label: t('sweep.weldcrm.tasksSection.dueOverdue'), sortOrder: 1, filter: (t) => !!(t.dueDate && t.dueDate < startOfToday && t.status !== 'done') },
      { id: 'today', label: t('sweep.weldcrm.notesView.today'), sortOrder: 2, filter: (t) => !!(t.dueDate && t.dueDate >= startOfToday && t.dueDate < startOfTomorrow) },
      { id: 'tomorrow', label: t('sweep.weldcrm.tasksSection.dueTomorrow'), sortOrder: 3, filter: (t) => !!(t.dueDate && t.dueDate >= startOfTomorrow && t.dueDate < startOfDayAfterTomorrow) },
      { id: 'this-week', label: t('sweep.weldcrm.callsSection.thisWeek'), sortOrder: 4, filter: (t) => !!(t.dueDate && t.dueDate >= startOfDayAfterTomorrow && t.dueDate < endOfWeek) },
      { id: 'later', label: t('sweep.weldcrm.tasksSection.upcoming'), sortOrder: 5, filter: (t) => !!(t.dueDate && t.dueDate >= endOfWeek) },
      { id: 'no-date', label: t('sweep.weldcrm.tasksSection.noDueDate'), sortOrder: 6, filter: (t) => !t.dueDate },
    ];
  }, [groupBy, availableAssignees, t]);

  // Group-by selector menu — rendered to the left of the filter button via
  // EntityList's `leftActionButtons` prop. Mirrors the canonical WeldFlow
  // tasks page (apps/web/platform/app/weldflow/project/[projectId]/tasks).
  const groupByOptions = [
    { value: 'status' as const, label: t('sweep.weldcrm.callsSection.status') },
    { value: 'priority' as const, label: t('sweep.weldcrm.tasksSection.priority') },
    { value: 'dueDate' as const, label: t('sweep.weldcrm.tasksSection.dueDate') },
    { value: 'assignee' as const, label: t('sweep.weldcrm.tasksSection.assignee') },
    { value: 'none' as const, label: t('sweep.weldcrm.tasksSection.none') },
  ];
  const groupByLabel = groupByOptions.find((o) => o.value === groupBy)?.label ?? t('sweep.weldcrm.tasksSection.dueDate');
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
        {groupByOptions.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            variant="ghost"
            onClick={() => setGroupBy(opt.value)}
            className={cn(
              'w-full flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-muted h-auto',
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

  // Apply filters function
  const applyFilters = useCallback((items: Task[], filters: ActiveFilter[]) => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    const startOfDayAfterTomorrow = new Date(startOfToday.getTime() + 2 * 24 * 60 * 60 * 1000);
    const endOfWeek = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);

    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(t => t.status === filter.value)
          : result.filter(t => t.status !== filter.value);
      } else if (filter.field === 'assignee') {
        result = filter.operator === 'is'
          ? result.filter(t => t.assignee?.name === filter.value)
          : result.filter(t => t.assignee?.name !== filter.value);
      } else if (filter.field === 'due date') {
        const matchesDueDate = (t: Task) => {
          switch (filter.value) {
            case 'overdue': return t.dueDate && t.dueDate < startOfToday && t.status !== 'done';
            case 'today': return t.dueDate && t.dueDate >= startOfToday && t.dueDate < startOfTomorrow;
            case 'tomorrow': return t.dueDate && t.dueDate >= startOfTomorrow && t.dueDate < startOfDayAfterTomorrow;
            case 'this-week': return t.dueDate && t.dueDate >= startOfDayAfterTomorrow && t.dueDate < endOfWeek;
            case 'later': return t.dueDate && t.dueDate >= endOfWeek;
            case 'no-date': return !t.dueDate;
            default: return true;
          }
        };
        result = filter.operator === 'is'
          ? result.filter(matchesDueDate)
          : result.filter(t => !matchesDueDate(t));
      } else if (filter.field === 'priority') {
        result = filter.operator === 'is'
          ? result.filter(t => t.priority === filter.value)
          : result.filter(t => t.priority !== filter.value);
      }
    });

    return result;
  }, []);

  const openTaskPanel = useCallback((task: Task) => {
    openObjectPanel({ type: 'task', id: task.id });
  }, [openObjectPanel]);

  // Handlers
  const openEditDialog = useCallback((task: Task) => {
    setEditingTask(task);
    setShowAddDialog(true);
  }, []);

  const handleDialogClose = useCallback((open: boolean) => {
    setShowAddDialog(open);
    if (!open) {
      setEditingTask(null);
    }
  }, []);

  const handleSaveTask = useCallback((data: Parameters<typeof createTaskMutation.mutate>[0]) => {
    createTaskMutation.mutate(data, {
      onSuccess: (result) => {
        if (result.success) {
          setShowAddDialog(false);
          setEditingTask(null);
        }
      },
    });
  }, [createTaskMutation]);

  const handleUpdateTask = useCallback((taskId: string, data: Parameters<typeof updateTaskMutation.mutate>[0]['data']) => {
    updateTaskMutation.mutate({ taskId, data }, {
      onSuccess: () => {
        setShowAddDialog(false);
        setEditingTask(null);
      },
    });
  }, [updateTaskMutation]);

  const toggleTaskStatus = useCallback((taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const newCompleted = task.status !== 'done';
    toggleTaskMutation.mutate({ taskId, completed: newCompleted });
  }, [tasks, toggleTaskMutation]);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Row renderer — adapted for narrower panel width (no Company column, tighter widths)
  const renderTaskRow = useCallback((task: Task, handlers: RowHandlers<Task>) => (
    <div key={task.id}>
      {/* Desktop row - hidden in panel mode. Matches the canonical WeldFlow
          tasks page row design (apps/web/platform/app/weldflow/project/[id]/tasks). */}
      {!isPanel && <div
        onClick={() => openTaskPanel(task)}
        className={cn(
          "hidden md:flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border group cursor-pointer hover:bg-gray-50 dark:hover:bg-secondary/50",
          task.status === 'done' && 'opacity-50'
        )}
      >
        {/* Checkbox */}
        <div className="flex-shrink-0 translate-y-[1px]" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={task.status === 'done'}
            onCheckedChange={() => toggleTaskStatus(task.id)}
            className="h-4 w-4"
          />
        </div>

        {/* Task Title */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2">
          <span className={cn(
            "text-sm font-medium truncate",
            task.status === 'done' ? 'line-through text-gray-400' : 'text-gray-900 dark:text-foreground'
          )}>
            {task.title}
          </span>
          {task.repeat && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 flex-shrink-0">
              <Repeat2 className="h-2.5 w-2.5" />
              {task.repeat.frequency === 'custom' && task.repeat.interval && task.repeat.unit
                ? `${task.repeat.interval}${task.repeat.unit.charAt(0)}`
                : task.repeat.frequency === 'biweekly' ? '2w' : task.repeat.frequency.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        {/* Status */}
        <div className="w-[120px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn(
                "-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow",
                (statusConfig[task.status] ?? statusConfig.todo).color,
                (statusConfig[task.status] ?? statusConfig.todo).bg
              )}>
                {(statusConfig[task.status] ?? statusConfig.todo).label}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {Object.entries(statusConfig).map(([key, config]) => (
                <Button
                  key={key}
                  variant="ghost"
                  onClick={() => handlers.onUpdate(task.id, { status: key as Task['status'] } as any)}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4 h-auto"
                >
                  <span>{config.label}</span>
                  {task.status === key && <Check className="h-3.5 w-3.5 text-primary" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {/* Priority — always renders, falls back to medium when unset
            (matches the canonical WeldFlow tasks page). */}
        <div className="w-[100px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={cn(
                "-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow",
                (priorityConfig[task.priority ?? 'medium'] ?? priorityConfig.medium).color,
                (priorityConfig[task.priority ?? 'medium'] ?? priorityConfig.medium).bg
              )}>
                {(priorityConfig[task.priority ?? 'medium'] ?? priorityConfig.medium).label}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {Object.entries(priorityConfig).map(([key, config]) => (
                <Button
                  key={key}
                  variant="ghost"
                  onClick={() => handlers.onUpdate(task.id, { priority: key as Task['priority'] } as any)}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4 h-auto"
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
              <Button variant="ghost" className="text-sm cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded px-1 py-0.5 transition-shadow h-auto">
                {task.dueDate ? (
                  <span className="font-mono text-gray-600 dark:text-muted-foreground">{formatDate(task.dueDate)}</span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={task.dueDate}
                onSelect={(date) => handlers.onUpdate(task.id, { dueDate: date } as any)}
                initialFocus
              />
              {task.dueDate && (
                <div className="p-1 border-t border-border">
                  <Button
                    variant="ghost"
                    onClick={() => handlers.onUpdate(task.id, { dueDate: undefined } as any)}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    <span>{t('sweep.weldcrm.dealDetailsModal.clear')}</span>
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Assignee */}
        <div className="w-[120px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  'cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded-[6px] pl-0.5 py-0.5 pr-1.5 transition-shadow h-auto',
                )}
              >
                {task.assignee ? (() => {
                  const avatarUrl = memberAvatarByName.get(task.assignee.name);
                  return (
                    <div className="flex items-center gap-1.5">
                      <Avatar className="h-5 w-5 !rounded-[7px]">
                        {avatarUrl && (
                          <AvatarImage src={avatarUrl} alt={task.assignee.name} className="!rounded-[7px]" />
                        )}
                        <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                          {task.assignee.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm text-gray-600 dark:text-muted-foreground truncate">
                        {task.assignee.name.split(' ')[0]}
                      </span>
                    </div>
                  );
                })() : (
                  <span className="text-sm text-gray-400">—</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {availableAssignees.map((name) => (
                <Button
                  key={name}
                  variant="ghost"
                  onClick={() => handlers.onUpdate(task.id, { assignee: { id: name, name } } as any)}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4 h-auto"
                >
                  <span className="flex items-center gap-2">
                    <Avatar className="h-5 w-5 !rounded-[7px]">
                      {memberAvatarByName.get(name) && (
                        <AvatarImage src={memberAvatarByName.get(name)} alt={name} className="!rounded-[7px]" />
                      )}
                      <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                        {name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span>{name}</span>
                  </span>
                  {task.assignee?.name === name && <Check className="h-3.5 w-3.5 text-primary" />}
                </Button>
              ))}
              {task.assignee && (
                <>
                  <div className="h-px bg-border my-1" />
                  <Button
                    variant="ghost"
                    onClick={() => handlers.onUpdate(task.id, { assignee: null } as any)}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    <span>{t('sweep.weldcrm.dealDetailsModal.clear')}</span>
                  </Button>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end flex-shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openEditDialog(task); }}>
                <Pencil className="mr-0.5 h-4 w-4" />
                {t('sweep.weldcrm.notesView.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                createTaskMutation.mutate({
                  title: t('sweep.weldcrm.tasksSection.taskCopyTitle', { title: task.title }),
                  description: task.description,
                  status: task.status,
                  priority: task.priority,
                  dueDate: task.dueDate,
                  linkedCompanyId: task.linkedCompany?.id,
                  repeat: task.repeat,
                });
              }}>
                <Copy className="mr-0.5 h-4 w-4" />
                {t('sweep.weldcrm.tasksSection.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); deleteTaskMutation.mutate(task.id); }}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                {t('sweep.weldcrm.customerDetailSidebar.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>}

      {/* Compact row - always in panel mode, mobile-only otherwise */}
      <div
        className={cn(
          isPanel ? "flex" : "md:hidden flex",
          "group items-center gap-3 px-4 py-3 border-b border-border/70 hover:bg-gray-50 dark:hover:bg-secondary/40 active:bg-muted/50 cursor-pointer transition-colors",
          task.status === 'done' && 'opacity-50'
        )}
        onClick={() => openTaskPanel(task)}
      >
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={task.status === 'done'}
            onCheckedChange={() => toggleTaskStatus(task.id)}
            className="h-4 w-4"
          />
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className={cn(
            "text-sm font-medium text-foreground truncate",
            task.status === 'done' && 'line-through text-muted-foreground'
          )}>
            {task.title}
          </span>
          {task.repeat && <Repeat2 className="h-3 w-3 text-indigo-500 shrink-0" />}
          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            <span className={cn(
              "inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none",
              statusConfig[task.status]?.color,
              statusConfig[task.status]?.bg
            )}>
              {statusConfig[task.status]?.label}
            </span>
            {task.priority && (
              <span className={cn(
                "inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none",
                priorityConfig[task.priority]?.color,
                priorityConfig[task.priority]?.bg
              )}>
                {priorityConfig[task.priority]?.label}
              </span>
            )}
            {task.dueDate && (
              <span className="text-xs text-muted-foreground font-mono">{formatDate(task.dueDate)}</span>
            )}
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEditDialog(task)}>
                <Pencil className="mr-0.5 h-4 w-4" />
                {t('sweep.weldcrm.notesView.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                createTaskMutation.mutate({
                  title: t('sweep.weldcrm.tasksSection.taskCopyTitle', { title: task.title }),
                  description: task.description,
                  status: task.status,
                  priority: task.priority,
                  dueDate: task.dueDate,
                  linkedCompanyId: task.linkedCompany?.id,
                  repeat: task.repeat,
                });
              }}>
                <Copy className="mr-0.5 h-4 w-4" />
                {t('sweep.weldcrm.tasksSection.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => deleteTaskMutation.mutate(task.id)}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                {t('sweep.weldcrm.customerDetailSidebar.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  ), [tasks, availableAssignees, toggleTaskStatus, openTaskPanel, openEditDialog, createTaskMutation, deleteTaskMutation, isPanel, t, statusConfig, priorityConfig]);

  // Header column definitions — match the canonical WeldFlow tasks page
  // (apps/web/platform/app/weldflow/project/[id]/tasks). The first column is the
  // checkbox (label "Task" lives here) so widths line up with the row cells.
  // The actions column has no header.
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'checkbox', header: t('sweep.weldcrm.tasksSection.task'), width: 'w-4 flex-shrink-0' },
    { id: 'task', header: '', width: 'min-w-[200px] flex-1' },
    { id: 'status', header: t('sweep.weldcrm.callsSection.status'), width: 'w-[120px]' },
    { id: 'priority', header: t('sweep.weldcrm.tasksSection.priority'), width: 'w-[100px]' },
    { id: 'dueDate', header: t('sweep.weldcrm.tasksSection.due'), width: 'w-[100px]' },
    { id: 'assignee', header: t('sweep.weldcrm.tasksSection.assignee'), width: 'w-[120px]' },
  ], [t]);

  return (
    <>
    <EntityList<Task>
      items={tasks}
      isLoading={isLoading}
      error={error}
      headerColumns={isPanel ? undefined : headerColumns}
      filters={filterConfigs}
      groups={groupConfigs}
      maxFilters={4}
      applyFilters={applyFilters}
      onUpdateItem={(id, data) => updateTaskMutation.mutate({ taskId: id, data })}
      onDeleteItem={(id) => deleteTaskMutation.mutate(id)}
      renderRow={renderTaskRow}
      leftActionButtons={groupByMenu}
      searchPlaceholder={t('sweep.weldcrm.tasksSection.searchTasks')}
      searchFields={['title', 'description']}
      emptyStateClassName="pb-24"
      createButton={{
        label: t('sweep.weldcrm.tasksSection.newTask'),
        onClick: () => setShowAddDialog(true),
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
        title: t('sweep.weldcrm.tasksSection.noTasksYet'),
        description: t('sweep.weldcrm.tasksSection.noTasksYetDescription'),
        action: {
          label: t('sweep.weldcrm.tasksSection.newTask'),
          onClick: () => setShowAddDialog(true),
        },
      }}
      noResultsState={{
        title: t('sweep.weldcrm.tasksSection.noTasksFound'),
        description: t('sweep.weldcrm.tasksSection.noTasksFoundDescription'),
      }}
      dialogComponent={
        <TaskDialog
          open={showAddDialog}
          onOpenChange={handleDialogClose}
          editingTask={editingTask}
          availableAssignees={availableAssignees}
          availableCompanies={availableCompanies}
          defaultRecord={customerDisplayName || undefined}
          onSave={handleSaveTask}
          onUpdate={handleUpdateTask}
          isPending={createTaskMutation.isPending || updateTaskMutation.isPending}
        />
      }
    />
  </>
  );
}
