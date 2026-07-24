
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { useUser } from '@clerk/clerk-react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  CheckCircle2,
  Circle,
  Clock,
  Trash2,
  Check,
  Repeat,
  EllipsisVertical,
  Pencil,
  Copy,
  List,
  Columns3,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { LabelOverflowList } from '@/app/weldflow/lib/label-overflow-list';
import {
  useCrmTasks,
  useCreateTask,
  useToggleTask,
  useUpdateTask,
  useDeleteTask,
  type Task,
} from '@/hooks/use-crm-tasks';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type RowHandlers } from '@/components/entity-list';
import { TaskDialog } from './task-dialog';
import { useObjectPanel } from '@/components/object-panel';
import { CrmTasksPipeline } from './crm-tasks-pipeline';
import { useTranslations } from '@weldsuite/i18n/client';
import { labelsApi } from '@/app/weldflow/lib/api-client';
import { localeConfig } from '@/lib/i18n/locales';
import { useLocale } from '@/hooks/use-preferences';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { useCompanies } from '@/components/objects/company/use-company-data';
import { useDebounce } from '@/hooks/use-debounce';

type CompanyOption = { id: string; name: string; avatar?: string };

interface WorkspaceMemberInfo {
  id?: string;
  userId?: string;
  name?: string;
  picture?: string;
}

const TASK_STATUS_ORDER = ['backlog', 'todo', 'in_progress', 'in_review', 'testing', 'done', 'cancelled'];
const TASK_PRIORITY_ORDER = ['low', 'medium', 'high'];

const CompanyPicker = React.memo(function CompanyPicker({
  taskId,
  linkedCompany,
  availableCompanyObjects,
  onCustomerSearch,
  noRecordsLabel,
  searchPlaceholder,
  onSelect,
}: {
  taskId: string;
  linkedCompany: { id: string; name: string } | undefined;
  availableCompanyObjects: CompanyOption[];
  onCustomerSearch: (value: string) => void;
  noRecordsLabel: string;
  searchPlaceholder: string;
  onSelect: (taskId: string, company: { id: string; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 250);

  useEffect(() => {
    if (!open) return;
    onCustomerSearch(debouncedSearch);
  }, [debouncedSearch, open, onCustomerSearch]);

  const selected = useMemo(
    () => (linkedCompany ? availableCompanyObjects.find((c) => c.id === linkedCompany.id) : undefined),
    [linkedCompany, availableCompanyObjects],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" className="text-sm cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded px-1 py-0.5 transition-shadow max-w-full text-left inline-flex items-center gap-1.5 min-w-0">
          {linkedCompany?.name ? (
            <>
              <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
                {selected?.avatar && (
                  <AvatarImage src={selected.avatar} alt={linkedCompany.name} className="!rounded-[7px]" />
                )}
                <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                  {linkedCompany.name.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="text-gray-600 dark:text-muted-foreground truncate">{linkedCompany.name}</span>
            </>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </Button>
      </PopoverTrigger>
      {open && (
        <PopoverContent className="w-[260px] p-0" align="start">
          <Command>
            <CommandInput
              placeholder={searchPlaceholder}
              className="h-9"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList
              onWheel={(e) => {
                e.currentTarget.scrollTop += e.deltaY;
              }}
            >
              <CommandEmpty>{noRecordsLabel}</CommandEmpty>
              <CommandGroup className="px-1 py-1">
                {availableCompanyObjects.map((company) => (
                  <CommandItem
                    key={company.id}
                    value={`${company.name} ${company.id}`}
                    onSelect={() => {
                      onSelect(taskId, { id: company.id, name: company.name });
                      setOpen(false);
                    }}
                    className={cn(
                      'flex items-center justify-between gap-2 px-1.5',
                      linkedCompany?.id === company.id && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="flex items-center gap-2 min-w-0 flex-1">
                      <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
                        {company.avatar && (
                          <AvatarImage src={company.avatar} alt={company.name} className="!rounded-[7px]" />
                        )}
                        <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                          {company.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate">{company.name}</span>
                    </span>
                    {linkedCompany?.id === company.id && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      )}
    </Popover>
  );
});

export default function CrmTasksClient() {
  const { user } = useUser();
  const t = useTranslations();
  const { locale: language } = useLocale();
  const intlLocale = localeConfig[language as keyof typeof localeConfig]?.intlLocale ?? 'en-US';
  const { data: tasks = [], isLoading, error } = useCrmTasks(user?.id);
  const { data: membersData } = useWorkspaceMembers(1, 100);
  const [customerSearch, setCustomerSearch] = useState('');
  const { data: companiesData } = useCompanies({
    limit: 100,
    search: customerSearch || undefined,
  });
  const createTaskMutation = useCreateTask();
  const toggleTaskMutation = useToggleTask();
  const updateTaskMutation = useUpdateTask();
  const deleteTaskMutation = useDeleteTask();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  // The task detail drawer is now rendered globally by <ObjectPanelHost />.
  // Opening it just pushes the task id onto the object-panel stack.
  const { open: openObjectPanel } = useObjectPanel();

  // Auto-open new-task dialog when ?new=1 is present (e.g. from onboarding checklist)
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowAddDialog(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete('new');
      const query = params.toString();
      router.replace(`/weldcrm${query ? `?${query}` : ''}`);
    }
  }, [searchParams, router]);
  const [viewMode, setViewMode] = useState<'list' | 'pipeline'>('list');
  const [groupBy, setGroupBy] = useState<'dueDate' | 'status' | 'priority' | 'assignee' | 'company' | 'none'>('dueDate');
  const [availableLabels, setAvailableLabels] = useState<{ id: string; name: string; color: string }[]>([]);
  const [sortState, setSortState] = useState<{ columnId: string; direction: 'asc' | 'desc' } | null>(null);

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

  const handleCreateLabel = useCallback(async (data: { name: string; color: string }) => {
    const result = await labelsApi.create(data);
    if (result.success && result.data) {
      const newLabel = { id: result.data.id, name: data.name, color: data.color };
      setAvailableLabels(prev => [newLabel, ...prev]);
      return newLabel;
    }
    return null;
  }, []);

  // Status configuration
  const statusConfig = useMemo(() => ({
    'backlog': { label: t('crm.tasks.status.backlog'), icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    'todo': { label: t('crm.tasks.status.todo'), icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    'in_progress': { label: t('crm.tasks.status.inProgress'), icon: Clock, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    'in_review': { label: t('crm.tasks.status.inReview'), icon: Clock, color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950' },
    'testing': { label: t('crm.tasks.status.testing'), icon: Clock, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
    'done': { label: t('crm.tasks.status.done'), icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
    'cancelled': { label: t('crm.tasks.status.cancelled'), icon: Circle, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  }), [t]);

  // Priority configuration
  const priorityConfig = useMemo(() => ({
    'low': { label: t('crm.tasks.priority.low'), color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
    'medium': { label: t('crm.tasks.priority.medium'), color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    'high': { label: t('crm.tasks.priority.high'), color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  }), [t]);

  // Due date configuration
  const dueDateConfig = useMemo(() => ({
    'overdue': { label: t('crm.tasks.dueDate.overdue') },
    'today': { label: t('crm.tasks.dueDate.today') },
    'tomorrow': { label: t('crm.tasks.dueDate.tomorrow') },
    'this-week': { label: t('crm.tasks.dueDate.thisWeek') },
    'later': { label: t('crm.tasks.dueDate.upcoming') },
    'no-date': { label: t('crm.tasks.dueDate.noDueDate') },
  }), [t]);

  // Memoize available assignees from workspace members
  const availableAssignees = useMemo(() => {
    const members = membersData?.data || [];
    return members
      .filter((m: WorkspaceMemberInfo): m is WorkspaceMemberInfo & { userId: string; name: string } =>
        Boolean(m.userId) && Boolean(m.name))
      .map((m) => ({ id: m.userId, name: m.name, avatar: m.picture || undefined }));
  }, [membersData]);

  const availableCompanyObjects = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatar?: string }>();
    for (const task of tasks) {
      if (task.linkedCompany) {
        map.set(task.linkedCompany.id, task.linkedCompany);
      }
    }
    for (const company of companiesData?.data || []) {
      const name = company.name || company.tradingName || company.displayName;
      if (name) {
        map.set(company.id, { id: company.id, name, avatar: company.avatarUrl || undefined });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks, companiesData]);

  const availableCompanies = useMemo(
    () => availableCompanyObjects.map((c) => c.name),
    [availableCompanyObjects]
  );

  // Filter configurations
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'company',
      label: t('crm.tasks.columns.company'),
      options: availableCompanies.map(name => ({ value: name, label: name })),
    },
    {
      field: 'status',
      label: t('crm.tasks.columns.status'),
      options: Object.entries(statusConfig).map(([key, config]) => ({ value: key, label: config.label })),
      getDisplayValue: (value) => statusConfig[value as keyof typeof statusConfig]?.label || value,
    },
    {
      field: 'priority',
      label: t('crm.tasks.columns.priority'),
      options: Object.entries(priorityConfig).map(([key, config]) => ({ value: key, label: config.label })),
      getDisplayValue: (value) => priorityConfig[value as keyof typeof priorityConfig]?.label || value,
    },
    {
      field: 'due date',
      label: t('crm.tasks.columns.due'),
      options: Object.entries(dueDateConfig).map(([key, config]) => ({ value: key, label: config.label })),
      getDisplayValue: (value) => dueDateConfig[value as keyof typeof dueDateConfig]?.label || value,
    },
    {
      field: 'assignee',
      label: t('crm.tasks.columns.assignee'),
      options: availableAssignees.map(a => ({ value: a.name, label: a.name })),
    },
    {
      field: 'label',
      label: t('crm.tasks.filters.label'),
      options: availableLabels.map(l => ({ value: l.id, label: l.name })),
      getDisplayValue: (value) => availableLabels.find(l => l.id === value)?.name || value,
    },
  ], [availableAssignees, availableCompanies, availableLabels, t, statusConfig, priorityConfig, dueDateConfig]);

  // Group configurations
  const groupConfigs: GroupConfig<Task>[] = useMemo(() => {
    if (groupBy === 'none') return [];

    if (groupBy === 'status') {
      return [
        { id: 'backlog', label: statusConfig.backlog.label, sortOrder: 1, filter: (t) => t.status === 'backlog' },
        { id: 'todo', label: statusConfig.todo.label, sortOrder: 2, filter: (t) => t.status === 'todo' },
        { id: 'in_progress', label: statusConfig.in_progress.label, sortOrder: 3, filter: (t) => t.status === 'in_progress' },
        { id: 'in_review', label: statusConfig.in_review.label, sortOrder: 4, filter: (t) => t.status === 'in_review' },
        { id: 'testing', label: statusConfig.testing.label, sortOrder: 5, filter: (t) => t.status === 'testing' },
        { id: 'done', label: statusConfig.done.label, sortOrder: 6, filter: (t) => t.status === 'done' },
        { id: 'cancelled', label: statusConfig.cancelled.label, sortOrder: 7, filter: (t) => t.status === 'cancelled' },
      ];
    }

    if (groupBy === 'priority') {
      return [
        { id: 'high', label: priorityConfig.high.label, sortOrder: 1, filter: (t) => t.priority === 'high' },
        { id: 'medium', label: priorityConfig.medium.label, sortOrder: 2, filter: (t) => t.priority === 'medium' },
        { id: 'low', label: priorityConfig.low.label, sortOrder: 3, filter: (t) => t.priority === 'low' },
        { id: 'no-priority', label: t('crm.tasks.groupBy.noPriority'), sortOrder: 4, filter: (t) => !t.priority },
      ];
    }

    if (groupBy === 'assignee') {
      const memberGroups: GroupConfig<Task>[] = availableAssignees.map((m, i) => ({
        id: `assignee-${m.id}`,
        label: m.name,
        sortOrder: i + 1,
        filter: (t: Task) => {
          const ids = t.assignees && t.assignees.length > 0
            ? t.assignees.map(a => a.id)
            : (t.assignee ? [t.assignee.id] : []);
          return ids.includes(m.id);
        },
      }));
      memberGroups.push({
        id: 'unassigned',
        label: t('crm.tasks.groupBy.unassigned'),
        sortOrder: availableAssignees.length + 1,
        filter: (t) => {
          const ids = t.assignees && t.assignees.length > 0
            ? t.assignees.map(a => a.id)
            : (t.assignee ? [t.assignee.id] : []);
          return ids.length === 0;
        },
      });
      return memberGroups;
    }

    if (groupBy === 'company') {
      const companyGroups: GroupConfig<Task>[] = availableCompanyObjects.map((c, i) => ({
        id: `company-${c.id}`,
        label: c.name,
        sortOrder: i + 1,
        filter: (t: Task) => t.linkedCompany?.id === c.id,
      }));
      companyGroups.push({
        id: 'no-company',
        label: t('crm.tasks.groupBy.noCompany'),
        sortOrder: availableCompanyObjects.length + 1,
        filter: (t) => !t.linkedCompany,
      });
      return companyGroups;
    }

    // Default: due date buckets (preserves the original behavior on this page).
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    const startOfDayAfterTomorrow = new Date(startOfToday.getTime() + 2 * 24 * 60 * 60 * 1000);
    const endOfWeek = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);

    return [
      {
        id: 'overdue',
        label: t('crm.tasks.dueDate.overdue'),
        sortOrder: 1,
        filter: (t) => !!(t.dueDate && t.dueDate < startOfToday && t.status !== 'done'),
      },
      {
        id: 'today',
        label: t('crm.tasks.dueDate.today'),
        sortOrder: 2,
        filter: (t) => !!(t.dueDate && t.dueDate >= startOfToday && t.dueDate < startOfTomorrow),
      },
      {
        id: 'tomorrow',
        label: t('crm.tasks.dueDate.tomorrow'),
        sortOrder: 3,
        filter: (t) => !!(t.dueDate && t.dueDate >= startOfTomorrow && t.dueDate < startOfDayAfterTomorrow),
      },
      {
        id: 'this-week',
        label: t('crm.tasks.dueDate.thisWeek'),
        sortOrder: 4,
        filter: (t) => !!(t.dueDate && t.dueDate >= startOfDayAfterTomorrow && t.dueDate < endOfWeek),
      },
      {
        id: 'later',
        label: t('crm.tasks.dueDate.upcoming'),
        sortOrder: 5,
        filter: (t) => !!(t.dueDate && t.dueDate >= endOfWeek),
      },
      {
        id: 'no-date',
        label: t('crm.tasks.dueDate.noDueDate'),
        sortOrder: 6,
        filter: (t) => !t.dueDate,
      },
    ];
  }, [groupBy, t, statusConfig, priorityConfig, availableAssignees, availableCompanyObjects]);

  const groupByOptions = [
    { value: 'dueDate' as const, label: t('crm.tasks.groupBy.options.dueDate') },
    { value: 'status' as const, label: t('crm.tasks.groupBy.options.status') },
    { value: 'priority' as const, label: t('crm.tasks.groupBy.options.priority') },
    { value: 'assignee' as const, label: t('crm.tasks.groupBy.options.assignee') },
    { value: 'company' as const, label: t('crm.tasks.groupBy.options.company') },
    { value: 'none' as const, label: t('crm.tasks.groupBy.options.none') },
  ];
  const groupByLabel = groupByOptions.find(o => o.value === groupBy)?.label ?? t('crm.tasks.groupBy.options.dueDate');

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
            variant="ghost"
            key={opt.value}
            type="button"
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
      } else if (filter.field === 'company') {
        result = filter.operator === 'is'
          ? result.filter(t => t.linkedCompany?.name === filter.value)
          : result.filter(t => t.linkedCompany?.name !== filter.value);
      } else if (filter.field === 'priority') {
        result = filter.operator === 'is'
          ? result.filter(t => t.priority === filter.value)
          : result.filter(t => t.priority !== filter.value);
      } else if (filter.field === 'label') {
        result = filter.operator === 'is'
          ? result.filter(t => Array.isArray(t.labels) && t.labels.includes(filter.value))
          : result.filter(t => !Array.isArray(t.labels) || !t.labels.includes(filter.value));
      }
    });

    return result;
  }, []);

  // Handlers
  const openTaskPanel = useCallback((task: Task) => {
    openObjectPanel({ type: 'task', id: task.id });
  }, [openObjectPanel]);

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

  const handleLinkCompany = useCallback((taskId: string, company: { id: string; name: string }) => {
    updateTaskMutation.mutate({ taskId, data: { linkedCompany: company } });
  }, [updateTaskMutation]);

  // The task detail panel is rendered globally and fetches its own data,
  // so no local task-sync ref/memo is needed here anymore.

  const toggleTaskStatus = useCallback((taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const newCompleted = task.status !== 'done';
    toggleTaskMutation.mutate({ taskId, completed: newCompleted });
  }, [tasks, toggleTaskMutation]);

  const handleStatusChange = useCallback((taskId: string, newStatus: Task['status']) => {
    updateTaskMutation.mutate({ taskId, data: { status: newStatus } });
  }, [updateTaskMutation]);

  const statusLabels = useMemo(() => ({
    'backlog': statusConfig['backlog'].label,
    'todo': statusConfig['todo'].label,
    'in_progress': statusConfig['in_progress'].label,
    'in_review': statusConfig['in_review'].label,
    'testing': statusConfig['testing'].label,
    'done': statusConfig['done'].label,
    'cancelled': statusConfig['cancelled'].label,
  }) as Record<Task['status'], string>, [statusConfig]);

  const priorityLabels = useMemo(() => ({
    'low': priorityConfig['low'].label,
    'medium': priorityConfig['medium'].label,
    'high': priorityConfig['high'].label,
  }), [priorityConfig]);

  const formatDate = useCallback((date: Date) => {
    return date.toLocaleDateString(intlLocale, { month: 'short', day: 'numeric' });
  }, [intlLocale]);

  // Row renderer — matches Weldflow my-tasks style
  const renderTaskRow = useCallback((task: Task, handlers: RowHandlers<Task>) => {
    const status = statusConfig[task.status] || statusConfig.todo;
    const priority = task.priority ? (priorityConfig[task.priority] || priorityConfig.medium) : null;

    return (
      <div
        key={task.id}
        onClick={() => openTaskPanel(task)}
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
          {task.repeat && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 flex-shrink-0">
              <Repeat className="h-2.5 w-2.5" />
              {task.repeat.frequency === 'custom' && task.repeat.interval && task.repeat.unit
                ? `${task.repeat.interval}${task.repeat.unit.charAt(0)}`
                : task.repeat.frequency === 'biweekly' ? '2w' : task.repeat.frequency.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        {/* Company */}
        <div className="w-[140px]" onClick={(e) => e.stopPropagation()}>
          <CompanyPicker
            taskId={task.id}
            linkedCompany={task.linkedCompany}
            availableCompanyObjects={availableCompanyObjects}
            onCustomerSearch={setCustomerSearch}
            noRecordsLabel={t('crm.tasks.noRecords')}
            searchPlaceholder={t('crm.tasks.searchRecords')}
            onSelect={handleLinkCompany}
          />
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
                  variant="ghost"
                  key={key}
                  onClick={() => handlers.onUpdate(task.id, { status: key as Task['status'] })}
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
              <Button variant="ghost" className={cn("px-2 py-0.5 rounded text-[12px] font-medium cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow", priority ? priority.color : 'text-gray-400', priority ? priority.bg : '')}>
                {priority ? priority.label : '—'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {Object.entries(priorityConfig).map(([key, config]) => (
                <Button
                  variant="ghost"
                  key={key}
                  onClick={() => handlers.onUpdate(task.id, { priority: key as Task['priority'] })}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4"
                >
                  <span>{config.label}</span>
                  {task.priority === key && <Check className="h-3.5 w-3.5 text-primary" />}
                </Button>
              ))}
              {task.priority && (
                <>
                  <div className="h-px bg-border my-1" />
                  <Button
                    variant="ghost"
                    onClick={() => handlers.onUpdate(task.id, { priority: undefined })}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    <span>{t('common.ui.form.clear')}</span>
                  </Button>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Due Date */}
        <div className="w-[100px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="text-sm cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded px-1 py-0.5 transition-shadow">
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
                onSelect={(date) => handlers.onUpdate(task.id, { dueDate: date })}
                initialFocus
              />
              {task.dueDate && (
                <div className="p-1 border-t border-border">
                  <Button
                    variant="ghost"
                    onClick={() => handlers.onUpdate(task.id, { dueDate: undefined })}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    <span>{t('common.ui.form.clear')}</span>
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Assignee(s) */}
        <div className="w-[120px]" onClick={(e) => e.stopPropagation()}>
          {(() => {
            const resolvedList = (task.assignees && task.assignees.length > 0
              ? task.assignees
              : task.assignee
                ? [task.assignee]
                : []
            ).map((a) => {
              const fromDirectory = availableAssignees.find((m) => m.id === a.id);
              return {
                id: a.id,
                name: fromDirectory?.name || a.name || t('common.labels.unknown'),
                avatar: fromDirectory?.avatar,
              };
            });
            const resolvedIds = resolvedList.map((a) => a.id);
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
                        variant="ghost"
                        key={member.id}
                        onClick={() => {
                          const nextIds = isSelected
                            ? resolvedIds.filter((id) => id !== member.id)
                            : [...resolvedIds, member.id];
                          const nextAssignees = nextIds.map((id) => {
                            const m = availableAssignees.find((x) => x.id === id);
                            return { id, name: m?.name || '' };
                          });
                          const primary = nextAssignees[0] ?? undefined;
                          handlers.onUpdate(task.id, {
                            assignee: primary,
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
                        onClick={() => handlers.onUpdate(task.id, { assignee: undefined, assignees: [] })}
                        className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        <span>{t('common.ui.form.clear')}</span>
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
              <DropdownMenuItem onClick={() => openEditDialog(task)}>
                <Pencil className="h-3.5 w-3.5 mr-0.5" />
                {t('common.actions.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                createTaskMutation.mutate({
                  title: `${task.title} (copy)`,
                  description: task.description,
                  status: task.status,
                  priority: task.priority,
                  dueDate: task.dueDate,
                  linkedCompanyId: task.linkedCompany?.id,
                  labels: task.labels,
                  repeat: task.repeat,
                });
              }}>
                <Copy className="h-3.5 w-3.5 mr-0.5" />
                {t('crm.tasks.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                onClick={() => deleteTaskMutation.mutate(task.id)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-600" />
                {t('common.actions.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [availableAssignees, availableLabels, availableCompanyObjects, setCustomerSearch, handleLinkCompany, toggleTaskStatus, openTaskPanel, openEditDialog, createTaskMutation, deleteTaskMutation, t, statusConfig, priorityConfig, formatDate]);

  const handleSort = useCallback((columnId: string) => {
    setSortState(prev => {
      if (prev?.columnId === columnId) {
        if (prev.direction === 'asc') return { columnId, direction: 'desc' as const };
        return null;
      }
      return { columnId, direction: 'asc' as const };
    });
  }, []);

  const sortedTasks = useMemo(() => {
    if (!sortState) return tasks;
    const { columnId, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;

    return [...tasks].sort((a, b) => {
      switch (columnId) {
        case 'status':
          return (TASK_STATUS_ORDER.indexOf(a.status) - TASK_STATUS_ORDER.indexOf(b.status)) * dir;
        case 'priority': {
          const aIdx = a.priority ? TASK_PRIORITY_ORDER.indexOf(a.priority) : -1;
          const bIdx = b.priority ? TASK_PRIORITY_ORDER.indexOf(b.priority) : -1;
          return (aIdx - bIdx) * dir;
        }
        case 'due': {
          const aTime = a.dueDate?.getTime() ?? Infinity;
          const bTime = b.dueDate?.getTime() ?? Infinity;
          return (aTime - bTime) * dir;
        }
        case 'assignee': {
          const aName = (a.assignee?.name || '').toLowerCase();
          const bName = (b.assignee?.name || '').toLowerCase();
          return aName.localeCompare(bName) * dir;
        }
        case 'company': {
          const aName = (a.linkedCompany?.name || '').toLowerCase();
          const bName = (b.linkedCompany?.name || '').toLowerCase();
          return aName.localeCompare(bName) * dir;
        }
        default:
          return 0;
      }
    });
  }, [tasks, sortState]);

  // Header column definitions
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'checkbox', header: '', width: 'w-4 flex-shrink-0' },
    { id: 'title', header: t('crm.tasks.columns.task'), width: 'min-w-[200px] flex-1', className: '-translate-x-8' },
    { id: 'company', header: t('crm.tasks.columns.company'), width: 'w-[140px]', sortable: true },
    { id: 'status', header: t('crm.tasks.columns.status'), width: 'w-[120px]', sortable: true },
    { id: 'priority', header: t('crm.tasks.columns.priority'), width: 'w-[100px]', sortable: true },
    { id: 'due', header: t('crm.tasks.columns.due'), width: 'w-[100px]', sortable: true },
    { id: 'assignee', header: t('crm.tasks.columns.assignee'), width: 'w-[120px]', sortable: true },
  ], [t]);

  const viewToggle = (
    <div className="flex items-center border bg-background dark:bg-input/30 dark:border-input rounded-md overflow-hidden shadow-none">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setViewMode('list')}
        className={cn(
          "h-[30px] w-8 flex items-center justify-center transition-colors",
          viewMode === 'list'
            ? "bg-accent text-accent-foreground dark:bg-input/50"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50"
        )}
        title={t('crm.tasks.view.listView')}
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setViewMode('pipeline')}
        className={cn(
          "h-[30px] w-8 flex items-center justify-center transition-colors",
          viewMode === 'pipeline'
            ? "bg-accent text-accent-foreground dark:bg-input/50"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50"
        )}
        title={t('crm.tasks.view.boardView')}
      >
        <Columns3 className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <>
      {viewMode === 'list' ? (
        <EntityList<Task>
          items={sortedTasks}
          isLoading={isLoading}
          error={error}
          headerColumns={headerColumns}
          filters={filterConfigs}
          groups={groupConfigs}
          maxFilters={5}
          applyFilters={applyFilters}
          onUpdateItem={(id, data) => updateTaskMutation.mutate({ taskId: id, data })}
          onDeleteItem={(id) => deleteTaskMutation.mutate(id)}
          renderRow={renderTaskRow}
          searchPlaceholder={`${t('common.actions.search')}...`}
          searchFields={['title', 'description']}
          sortState={sortState}
          onSort={handleSort}
          leftActionButtons={<>{groupByMenu}{viewToggle}</>}
          createButton={{
            label: t('crm.tasks.newTask'),
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
                  <rect x="48" y="94" width="28" height="3" rx="1.5" className="fill-gray-150 dark:fill-white/15" opacity="0.4" />
                  <rect x="48" y="100" width="18" height="2" rx="1" className="fill-gray-100 dark:fill-white/10" opacity="0.3" />
                </svg>
              </EmptyStateIllustration>
            ),
            title: t('crm.tasks.emptyState.title'),
            description: t('crm.tasks.emptyState.description'),
            action: {
              label: t('crm.tasks.newTask'),
              onClick: () => setShowAddDialog(true),
            },
          }}
          noResultsState={{
            title: t('crm.tasks.noResults.title'),
            description: t('crm.tasks.noResults.description'),
          }}
        />
      ) : (
        <CrmTasksPipeline
          tasks={tasks}
          filterConfigs={filterConfigs}
          onTaskClick={openTaskPanel}
          onStatusChange={handleStatusChange}
          onCreateTask={() => setShowAddDialog(true)}
          viewToggle={viewToggle}
          statusLabels={statusLabels}
          priorityLabels={priorityLabels}
          searchPlaceholder={`${t('common.actions.search')}...`}
          newTaskLabel={t('crm.tasks.newTask')}
        />
      )}

      <TaskDialog
        open={showAddDialog}
        onOpenChange={handleDialogClose}
        editingTask={editingTask}
        availableAssignees={availableAssignees}
        availableCompanies={availableCompanyObjects}
        onRecordSearchChange={setCustomerSearch}
        recordRequired
        availableLabels={availableLabels}
        onCreateLabel={handleCreateLabel}
        defaultAssignee={user?.id}
        onSave={handleSaveTask}
        onUpdate={handleUpdateTask}
        isPending={createTaskMutation.isPending || updateTaskMutation.isPending}
      />
      {/* Task detail panel is rendered globally via ObjectPanelHost. */}
    </>
  );
}
