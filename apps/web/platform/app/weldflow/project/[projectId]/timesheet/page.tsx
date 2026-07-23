
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams } from '@/lib/router';
import { useUser } from '@clerk/clerk-react';
import { format } from 'date-fns';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Play,
  Square,
  Clock,
  CalendarIcon,
  Loader2,
  AlertCircle,
  User,
  X,
  Trash2,
  Check,
  ChevronsUpDown,
  Search,
  Link2,
  FileText,
  Pencil,
  DollarSign,
} from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { timeEntriesApi, tasksApi, membersApi } from '@/app/weldflow/lib/api-client';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  TimerAlreadyRunningError,
  useDiscardTimer,
  useElapsedSeconds,
  useRunningTimer,
  useStartTimer,
  useStopTimer,
} from '@/hooks/queries/use-timer-queries';

interface TimeEntry {
  id: string;
  taskId?: string;
  taskName?: string;
  description?: string;
  date: Date;
  duration: number; // minutes
  /** Optional clock times — set when logged via a range or by the timer. */
  startTime?: string | null;
  endTime?: string | null;
  userId: string;
  userName?: string;
  billable: boolean;
  status: string;
  task?: {
    id: string;
    title: string;
  };
  user?: {
    id: string;
    name: string;
    email: string;
  };
}

interface ProjectTask {
  id: string;
  title: string;
}

interface ProjectMember {
  id: string;
  userId: string;
  role: string;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

interface WeekDay {
  date: Date;
  dayName: string;
  dayNumber: number;
  monthName: string;
  isToday: boolean;
  isWeekend: boolean;
}

export default function TimesheetPage() {
  const params = useParams();
  const { user } = useUser();
  const projectId = params.projectId as string;
  const currentUserId = user?.id;
  const currentUserName = user?.fullName || 'User';

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentWeekStart, setCurrentWeekStart] = useState<Date>(() => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  });
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [newEntryTaskId, setNewEntryTaskId] = useState('');
  const [newEntryTaskName, setNewEntryTaskName] = useState('');
  const [newEntryHours, setNewEntryHours] = useState('');
  const [newEntryMinutes, setNewEntryMinutes] = useState('');
  const [newEntryDescription, setNewEntryDescription] = useState('');
  const [newEntryBillable, setNewEntryBillable] = useState(true);
  const [newEntryRoundTo, setNewEntryRoundTo] = useState('none');
  // Optional clock times ("HH:mm"). When both are set the duration is derived
  // from them and the hours/minutes inputs become read-only mirrors.
  const [newEntryStartTime, setNewEntryStartTime] = useState('');
  const [newEntryEndTime, setNewEntryEndTime] = useState('');
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [datePickerMonth, setDatePickerMonth] = useState<Date | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [taskSelectorOpen, setTaskSelectorOpen] = useState(false);
  const [taskSearchQuery, setTaskSearchQuery] = useState('');
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const [entryToDelete, setEntryToDelete] = useState<TimeEntry | null>(null);

  const tt = getTranslations('projects').projectTimesheets;
  const st = useTranslations();

  // Timer state. The running timer itself lives on the server (one per user),
  // so it survives refresh and navigation; only the compose-time fields below
  // are local. `timerSeconds` is derived from the server's startedAt rather
  // than counted up locally, so a backgrounded tab still shows the truth.
  const { data: runningTimer } = useRunningTimer();
  const startTimerMutation = useStartTimer();
  const stopTimerMutation = useStopTimer();
  const discardTimerMutation = useDiscardTimer();
  // Only surface the in-page control for a timer belonging to THIS project —
  // a timer running against another project is the global widget's business,
  // and stopping it from here would silently log time to the wrong project.
  const isTimerRunning = !!runningTimer && runningTimer.projectId === projectId;
  const timerSeconds = useElapsedSeconds(runningTimer?.startedAt);
  const [timerTaskId, setTimerTaskId] = useState('');
  const [timerTaskName, setTimerTaskName] = useState('');
  const [timerDescription, setTimerDescription] = useState('');
  const [timerBillable, setTimerBillable] = useState(true);
  const [showTimerDialog, setShowTimerDialog] = useState(false);
  const [timerTaskSelectorOpen, setTimerTaskSelectorOpen] = useState(false);
  const [timerTaskSearchQuery, setTimerTaskSearchQuery] = useState('');
  const [timerRoundTo, setTimerRoundTo] = useState('none');

  const [hoveredCell, setHoveredCell] = useState<{ task: string; day: number } | null>(null);
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');

  // Filter and search state
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [headerDatePickerOpen, setHeaderDatePickerOpen] = useState(false);

  // Create-task popup (uses the shared TaskDialog used on the tasks page).
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [currentMonth, setCurrentMonth] = useState<Date>(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  // Filter configurations for timesheet entries
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'billable',
      label: st('sweep.weldflow.timesheetPage.billable'),
      filterType: 'boolean' as const,
      options: [
        { value: 'true', label: st('sweep.weldflow.timesheetPage.yes') },
        { value: 'false', label: st('sweep.weldflow.timesheetPage.no') },
      ],
    },
    {
      field: 'task',
      label: st('sweep.weldflow.timesheetPage.task'),
      options: tasks.map(t => ({ value: t.id, label: t.title })),
    },
    {
      field: 'member',
      label: st('sweep.weldflow.timesheetPage.member'),
      options: projectMembers
        .filter(m => m.user?.name)
        .map(m => ({ value: m.userId, label: m.user!.name })),
    },
  ], [tasks, projectMembers, st]);

  // Load data
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [entriesResult, tasksResult, membersResult] = await Promise.all([
        timeEntriesApi.list(projectId, { limit: 500 }),
        tasksApi.list(projectId),
        membersApi.list(projectId),
      ]);

      if (entriesResult.success) {
        const rawEntries = Array.isArray(entriesResult.data)
          ? entriesResult.data
          : entriesResult.data?.items || [];
        const transformedEntries = rawEntries.map((entry: any) => ({
          id: entry.id,
          taskId: entry.taskId,
          taskName: entry.task?.title || entry.description || 'Untitled',
          description: entry.description,
          date: new Date(String(entry.date).substring(0, 10) + 'T00:00:00'),
          duration: Number(entry.duration) || entry.durationMinutes || 0,
          startTime: entry.startTime ?? null,
          endTime: entry.endTime ?? null,
          userId: entry.userId,
          userName: entry.user?.name || 'Unknown',
          billable: entry.billable ?? entry.isBillable ?? true,
          status: entry.status || 'draft',
          task: entry.task,
          user: entry.user,
        }));
        setEntries(transformedEntries);
      } else {
        setError(entriesResult.error || 'Failed to load time entries');
      }

      if (tasksResult.success) {
        setTasks((tasksResult.data || []).map((task: any) => ({
          id: task.id,
          title: task.title,
        })));
      }

      if (membersResult.success) {
        setProjectMembers(membersResult.data || []);
      }
    } catch (err) {
      console.error('Error loading data:', err);
      setError('Failed to load data');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Generate week days
  const weekDays = useMemo((): WeekDay[] => {
    const days: WeekDay[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < 7; i++) {
      const date = new Date(currentWeekStart);
      date.setDate(currentWeekStart.getDate() + i);

      days.push({
        date,
        dayName: format(date, 'EEE'),
        dayNumber: date.getDate(),
        monthName: format(date, 'MMM'),
        isToday: date.getTime() === today.getTime(),
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
      });
    }
    return days;
  }, [currentWeekStart]);

  // Get unique task names from entries
  const uniqueTaskNames = useMemo(() => {
    const taskMap = new Map<string, { name: string; taskId: string | null }>();
    entries.forEach(e => {
      const key = e.taskId || `desc:${e.description || e.taskName || 'other'}`;
      if (!taskMap.has(key)) {
        taskMap.set(key, {
          name: e.task?.title || e.taskName || e.description || 'Untitled',
          taskId: e.taskId || null,
        });
      }
    });
    return Array.from(taskMap.entries()).map(([id, v]) => ({
      id,
      name: v.name,
      taskId: v.taskId,
      hasTask: !!v.taskId,
    }));
  }, [entries]);

  // Filter tasks based on search query
  const filteredTasks = useMemo(() => {
    if (!taskSearchQuery.trim()) return tasks;
    return tasks.filter(task =>
      task.title.toLowerCase().includes(taskSearchQuery.toLowerCase())
    );
  }, [tasks, taskSearchQuery]);

  const filteredTimerTasks = useMemo(() => {
    if (!timerTaskSearchQuery.trim()) return tasks;
    return tasks.filter(task =>
      task.title.toLowerCase().includes(timerTaskSearchQuery.toLowerCase())
    );
  }, [tasks, timerTaskSearchQuery]);

  // Get entries matching a row key (real taskId or description-only) for a given date
  const getEntriesForCell = (rowKey: string, date: Date): TimeEntry[] => {
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    return entries.filter(entry => {
      const entryDate = new Date(entry.date);
      entryDate.setHours(0, 0, 0, 0);
      if (entryDate.getTime() !== targetDate.getTime()) return false;
      if (rowKey.startsWith('desc:')) {
        const desc = rowKey.slice(5);
        return !entry.taskId && (entry.description || entry.taskName || 'other') === desc;
      }
      return entry.taskId === rowKey;
    });
  };

  // Get hours for a specific date and task row
  const getHoursForCell = (rowKey: string, _taskName: string, date: Date): number => {
    return getEntriesForCell(rowKey, date).reduce((sum, entry) => sum + (entry.duration / 60), 0);
  };

  // Calculate total hours for a date
  const getTotalHoursForDate = (date: Date): number => {
    return entries
      .filter(entry => {
        const entryDate = new Date(entry.date);
        entryDate.setHours(0, 0, 0, 0);
        const targetDate = new Date(date);
        targetDate.setHours(0, 0, 0, 0);
        return entryDate.getTime() === targetDate.getTime();
      })
      .reduce((sum, entry) => sum + (entry.duration / 60), 0);
  };

  // Calculate total hours for a task in current week
  const getTotalHoursForTask = (taskId: string, taskName: string): number => {
    return weekDays.reduce((sum, day) => sum + getHoursForCell(taskId, taskName, day.date), 0);
  };

  // Calculate weekly total
  const weeklyTotal = useMemo(() => {
    return weekDays.reduce((sum, day) => sum + getTotalHoursForDate(day.date), 0);
  }, [weekDays, entries]);

  // Navigate weeks
  const goToPreviousWeek = () => {
    const newStart = new Date(currentWeekStart);
    newStart.setDate(newStart.getDate() - 7);
    setCurrentWeekStart(newStart);
  };

  const goToNextWeek = () => {
    const newStart = new Date(currentWeekStart);
    newStart.setDate(newStart.getDate() + 7);
    setCurrentWeekStart(newStart);
  };

  const goToToday = () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    setCurrentWeekStart(monday);
  };

  // Format timer display
  const formatTimer = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  /**
   * Minutes between two "HH:mm" clock times, or null when either is missing or
   * the range is not positive. An end before the start is rejected rather than
   * wrapped past midnight — the entry is anchored to a single calendar date.
   */
  const minutesFromRange = (start: string, end: string): number | null => {
    if (!start || !end) return null;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return null;
    const minutes = eh * 60 + em - (sh * 60 + sm);
    return minutes > 0 ? minutes : null;
  };

  /** "HH:mm" on the given date as an ISO string, or undefined when unset. */
  const combineDateAndTime = (date: Date, time: string): string | undefined => {
    if (!time) return undefined;
    const [h, m] = time.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return undefined;
    const combined = new Date(date);
    combined.setHours(h, m, 0, 0);
    return combined.toISOString();
  };

  // Handle add entry
  const handleAddEntry = async () => {
    if (!selectedDate) return;
    const submitDate = selectedDate;

    // Clock times win when both are supplied — the duration inputs mirror them.
    const rangeMinutes = minutesFromRange(newEntryStartTime, newEntryEndTime);
    if (newEntryStartTime && newEntryEndTime && rangeMinutes === null) {
      toast.error(tt.endAfterStart);
      return;
    }

    const totalMinutesRaw =
      rangeMinutes ??
      (parseInt(newEntryHours || '0', 10) || 0) * 60 +
        (parseInt(newEntryMinutes || '0', 10) || 0);
    if (!totalMinutesRaw) return;

    let totalMinutes = totalMinutesRaw;

    // Round time if enabled
    if (newEntryRoundTo !== 'none') {
      const roundToMinutes = parseInt(newEntryRoundTo);
      totalMinutes = Math.round(totalMinutes / roundToMinutes) * roundToMinutes;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        taskId: newEntryTaskId || undefined,
        description: newEntryDescription || newEntryTaskName || undefined,
        date: format(submitDate, 'yyyy-MM-dd'),
        durationMinutes: totalMinutes,
        isBillable: newEntryBillable,
        startTime: combineDateAndTime(submitDate, newEntryStartTime),
        endTime: combineDateAndTime(submitDate, newEntryEndTime),
      };
      const result = editingEntryId
        ? await timeEntriesApi.update(projectId, editingEntryId, payload)
        : await timeEntriesApi.create(projectId, payload);

      if (result.success) {
        toast.success(editingEntryId ? st('sweep.weldflow.timesheetPage.timeEntryUpdated') : st('sweep.weldflow.timesheetPage.timeEntryCreated'));
        setShowAddDialog(false);
        setEditingEntryId(null);
        setNewEntryTaskId('');
        setNewEntryTaskName('');
        setNewEntryHours('');
        setNewEntryMinutes('');
        setNewEntryDescription('');
        setNewEntryBillable(true);
        setNewEntryRoundTo('none');
        setNewEntryStartTime('');
        setNewEntryEndTime('');
        setSelectedDate(null);
        loadData();
      } else {
        toast.error(result.error || st('sweep.weldflow.timesheetPage.saveFailed'));
      }
    } catch (err) {
      toast.error(st('sweep.weldflow.timesheetPage.saveFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Open add dialog in edit mode for an existing entry
  const openEditDialog = (entry: TimeEntry) => {
    setEditingEntryId(entry.id);
    setNewEntryTaskId(entry.taskId || '');
    setNewEntryTaskName(entry.task?.title || '');
    setNewEntryDescription(entry.description || '');
    const minutes = Math.max(0, Math.round(entry.duration));
    setNewEntryHours(String(Math.floor(minutes / 60)));
    setNewEntryMinutes(String(minutes % 60));
    setNewEntryBillable(entry.billable);
    setNewEntryStartTime(entry.startTime ? format(new Date(entry.startTime), 'HH:mm') : '');
    setNewEntryEndTime(entry.endTime ? format(new Date(entry.endTime), 'HH:mm') : '');
    setSelectedDate(new Date(entry.date));
    setShowAddDialog(true);
  };

  // Delete an entry
  const handleDeleteEntry = async (entryId: string) => {
    setDeletingEntryId(entryId);
    try {
      const result = await timeEntriesApi.delete(projectId, entryId);
      if (result.success) {
        toast.success(st('sweep.weldflow.timesheetPage.timeEntryDeleted'));
        loadData();
      } else {
        toast.error(result.error || st('sweep.weldflow.timesheetPage.deleteFailed'));
      }
    } catch {
      toast.error(st('sweep.weldflow.timesheetPage.deleteFailed'));
    } finally {
      setDeletingEntryId(null);
    }
  };

  const resetTimerFields = () => {
    setTimerTaskId('');
    setTimerTaskName('');
    setTimerDescription('');
  };

  // Start timer after dialog confirmation. The server owns the timer, so a
  // 409 here means one is already running (possibly started on another device).
  const startTimer = async () => {
    if (!timerTaskName && !timerTaskId) {
      toast.error(st('sweep.weldflow.timesheetPage.pleaseSelectTask'));
      return;
    }
    try {
      await startTimerMutation.mutateAsync({
        projectId,
        taskId: timerTaskId || undefined,
        description: timerDescription || timerTaskName || undefined,
        billable: timerBillable,
      });
      setShowTimerDialog(false);
      toast.success(tt.timerStarted);
    } catch (err) {
      if (err instanceof TimerAlreadyRunningError) {
        setShowTimerDialog(false);
        toast.error(tt.timerAlreadyRunning);
        return;
      }
      toast.error(tt.failedToStartTimer);
    }
  };

  // Stop the timer. The server derives the duration from startedAt and writes
  // the entry, so the elapsed time is authoritative even if this tab slept.
  const stopTimerAndSave = async () => {
    try {
      const entry = await stopTimerMutation.mutateAsync({});
      let durationMinutes = Math.max(1, Math.round(Number(entry.duration)));

      // Rounding is a client-side preference, so it's applied as a follow-up
      // edit to the entry the server just created.
      if (timerRoundTo !== 'none') {
        const roundTo = parseInt(timerRoundTo);
        const rounded = Math.max(roundTo, Math.round(durationMinutes / roundTo) * roundTo);
        if (rounded !== durationMinutes) {
          durationMinutes = rounded;
          await timeEntriesApi.update(projectId, entry.id, { durationMinutes: rounded });
        }
      }

      toast.success(st('sweep.weldflow.timesheetPage.loggedHours', { hours: Math.round((durationMinutes / 60) * 10) / 10 }));
      resetTimerFields();
      loadData();
    } catch {
      toast.error(st('sweep.weldflow.timesheetPage.saveFailed'));
    }
  };

  // Throw the running timer away without recording anything.
  const discardTimer = async () => {
    try {
      await discardTimerMutation.mutateAsync();
      resetTimerFields();
      toast.success(tt.timerDiscarded);
    } catch {
      toast.error(tt.failedToDiscardTimer);
    }
  };

  // Create a new task via the shared TaskDialog and auto-select it into the
  // log-time form.
  const handleTaskDialogSave = async (data: {
    title: string;
    description?: string;
    status: 'todo' | 'in_progress' | 'done' | string;
    priority?: 'low' | 'medium' | 'high';
    assigneeId?: string;
    assigneeIds?: string[];
    dueDate?: Date;
  }) => {
    setIsCreatingTask(true);
    try {
      const result = await tasksApi.create(projectId, {
        title: data.title,
        description: data.description || undefined,
        status: (data.status as 'todo' | 'in_progress' | 'done') ?? 'todo',
        priority: data.priority ?? 'medium',
        assigneeId: data.assigneeId ?? data.assigneeIds?.[0] ?? undefined,
        dueDate: data.dueDate?.toISOString(),
      });

      if (result.success && result.data) {
        setTasks((prev) => [...prev, { id: result.data.id, title: result.data.title }]);
        setNewEntryTaskId(result.data.id);
        setNewEntryTaskName(result.data.title);
        setShowCreateTaskDialog(false);
        setShowAddDialog(true);
        toast.success(st('sweep.weldflow.timesheetPage.taskCreated'));
      } else {
        toast.error(result.error || st('sweep.weldflow.timesheetPage.taskCreateFailed'));
      }
    } catch {
      toast.error(st('sweep.weldflow.timesheetPage.taskCreateFailed'));
    } finally {
      setIsCreatingTask(false);
    }
  };

  // Week range display
  const weekRangeDisplay = useMemo(() => {
    const endOfWeek = new Date(currentWeekStart);
    endOfWeek.setDate(currentWeekStart.getDate() + 6);

    const startMonth = format(currentWeekStart, 'MMM');
    const endMonth = format(endOfWeek, 'MMM');
    const year = currentWeekStart.getFullYear();

    if (startMonth === endMonth) {
      return `${startMonth} ${currentWeekStart.getDate()} - ${endOfWeek.getDate()}, ${year}`;
    }
    return `${startMonth} ${currentWeekStart.getDate()} - ${endMonth} ${endOfWeek.getDate()}, ${year}`;
  }, [currentWeekStart]);

  // Month display
  const monthDisplay = useMemo(() => {
    return format(currentMonth, 'MMMM yyyy');
  }, [currentMonth]);

  // Generate month weeks for calendar view
  const monthWeeks = useMemo(() => {
    const weeks: WeekDay[][] = [];
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    let startDate = new Date(firstDay);
    const dayOfWeek = firstDay.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    startDate.setDate(firstDay.getDate() + diff);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    while (startDate <= lastDay || weeks.length === 0) {
      const week: WeekDay[] = [];
      for (let i = 0; i < 7; i++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + i);
        week.push({
          date,
          dayName: format(date, 'EEE'),
          dayNumber: date.getDate(),
          monthName: format(date, 'MMM'),
          isToday: date.getTime() === today.getTime(),
          isWeekend: date.getDay() === 0 || date.getDay() === 6,
        });
      }
      weeks.push(week);
      startDate.setDate(startDate.getDate() + 7);

      if (weeks.length > 6) break;
    }

    return weeks;
  }, [currentMonth]);

  // Navigate months
  const goToPreviousMonth = () => {
    const newMonth = new Date(currentMonth);
    newMonth.setMonth(newMonth.getMonth() - 1);
    setCurrentMonth(newMonth);
  };

  const goToNextMonth = () => {
    const newMonth = new Date(currentMonth);
    newMonth.setMonth(newMonth.getMonth() + 1);
    setCurrentMonth(newMonth);
  };

  // Open add dialog for specific cell
  const openAddDialogForCell = (taskId: string, taskName: string, date: Date) => {
    setSelectedDate(date);
    setNewEntryTaskId(taskId);
    setNewEntryTaskName(taskName);
    setShowAddDialog(true);
  };

  // Loading state
  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <AlertCircle className="h-12 w-12 text-red-400" />
          <p className="text-lg font-medium">{error}</p>
          <Button onClick={loadData}>{st('sweep.weldflow.timesheetPage.retry')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[53px] border-b border-border bg-background">
        <div className="flex items-center gap-2">
          {/* Filter Pills */}
          <div className="hidden md:flex items-center">
            <FilterPills
              filters={activeFilters}
              filterConfigs={filterConfigs}
              maxFilters={5}
              onFiltersChange={setActiveFilters}
            />
          </div>

          {/* View Mode Select */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-[90px] justify-between shadow-none text-sm text-muted-foreground">
                {{ week: 'Week', month: 'Month' }[viewMode]}
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[90px] p-1">
              {([['week', 'Week'], ['month', 'Month']] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  onClick={() => setViewMode(value)}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded h-auto"
                >
                  <span>{label}</span>
                  {viewMode === value && <Check className="h-3.5 w-3.5" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Navigation */}
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={viewMode === 'week' ? goToPreviousWeek : goToPreviousMonth}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={viewMode === 'week' ? goToNextWeek : goToNextMonth}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Date Picker */}
          <Popover open={headerDatePickerOpen} onOpenChange={setHeaderDatePickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-1 shadow-none font-medium text-sm -ml-2"
              >
                <span className="hidden md:inline">
                  {viewMode === 'week' ? weekRangeDisplay : monthDisplay}
                </span>
                <span className="md:hidden">
                  {viewMode === 'week'
                    ? `${format(currentWeekStart, 'MMM d')} - ${format(new Date(currentWeekStart.getTime() + 6 * 24 * 60 * 60 * 1000), 'd')}`
                    : format(currentMonth, 'MMM yyyy')
                  }
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start" sideOffset={8}>
              <Calendar
                mode="single"
                selected={viewMode === 'week' ? currentWeekStart : currentMonth}
                month={viewMode === 'week' ? currentWeekStart : currentMonth}
                onMonthChange={(month) => {
                  if (viewMode === 'month') {
                    setCurrentMonth(month);
                  }
                }}
                captionLayout="dropdown"
                onSelect={(date) => {
                  if (!date) return;
                  if (viewMode === 'week') {
                    const dayOfWeek = date.getDay();
                    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
                    const monday = new Date(date);
                    monday.setDate(date.getDate() + diff);
                    monday.setHours(0, 0, 0, 0);
                    setCurrentWeekStart(monday);
                  } else {
                    setCurrentMonth(new Date(date.getFullYear(), date.getMonth(), 1));
                  }
                  setHeaderDatePickerOpen(false);
                }}
              />
              <div className="border-t px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-8 text-sm"
                  onClick={() => {
                    goToToday();
                    if (viewMode === 'month') {
                      setCurrentMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
                    }
                    setHeaderDatePickerOpen(false);
                  }}
                >
                  {st('sweep.weldflow.notesView.today')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative flex items-center">
            <div
              className={cn(
                "flex items-center transition-all duration-200 ease-out",
                searchOpen ? "w-48" : "w-8"
              )}
            >
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200",
                  searchOpen && "opacity-0 pointer-events-none absolute"
                )}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
              <div className={cn(
                "relative transition-all duration-200 ease-out",
                searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
              )}>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={st('sweep.weldflow.timesheetPage.searchEntriesPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Timer — start, or stop the one already running. The running timer
              is server state, so this reflects timers started elsewhere too. */}
          {isTimerRunning ? (
            <div className="flex items-center gap-1">
              <span className="font-mono text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatTimer(timerSeconds)}
              </span>
              <Button
                size="sm"
                variant="default"
                className="h-8 shadow-none"
                onClick={stopTimerAndSave}
                disabled={stopTimerMutation.isPending}
              >
                <Square className="h-3.5 w-3.5 mr-1 fill-current" />
                <span className="hidden md:inline">{tt.stop}</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 shadow-none"
                onClick={discardTimer}
                disabled={discardTimerMutation.isPending}
                title={tt.discardTimer}
                aria-label={tt.discardTimer}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 shadow-none"
              onClick={() => setShowTimerDialog(true)}
            >
              <Play className="h-3.5 w-3.5 mr-1" />
              <span className="hidden md:inline">{tt.startTimer}</span>
            </Button>
          )}

          {/* Add Entry Button */}
          <Button
            size="sm"
            className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 shadow-none"
            onClick={() => {
              setSelectedDate(new Date());
              setShowAddDialog(true);
            }}
          >
            <Plus className="h-4 w-4 mr-0.5" />
            <span className="hidden md:inline">{st('sweep.weldflow.timesheetPage.logTime')}</span>
          </Button>
        </div>
      </div>

      {/* Timesheet Grid */}
      <div className="flex-1 overflow-auto">
        {viewMode === 'week' ? (
          /* Weekly View */
          <div className="min-w-[900px]">
            {/* Header Row */}
            <div
              className="grid grid-cols-[240px_repeat(7,1fr)_80px] sticky top-0 bg-background border-b border-border z-10"
              style={{ height: '78.5px' }}
            >
              <div className="px-5 flex items-center text-[13px] font-mono font-medium text-[#666] dark:text-[#888] uppercase tracking-wide">
                {st('sweep.weldflow.timesheetPage.task')}
              </div>
              {weekDays.map((day, index) => (
                <div
                  key={index}
                  className={cn(
                    "text-center flex flex-col items-center justify-center border-l border-border",
                    day.isToday && "bg-zinc-50/60 dark:bg-zinc-900/30"
                  )}
                >
                  <div
                    className={cn(
                      "text-[11px] font-medium uppercase tracking-wide",
                      day.isToday ? "font-semibold" : "text-muted-foreground"
                    )}
                    style={day.isToday ? { color: '#3073f1' } : undefined}
                  >
                    {day.dayName}
                  </div>
                  <div
                    className={cn(
                      "text-[22px] font-medium leading-tight mt-1",
                      day.isToday ? "font-semibold" : "text-foreground"
                    )}
                    style={day.isToday ? { color: '#3073f1' } : undefined}
                  >
                    {day.dayNumber}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-center border-l border-border bg-background">
                <p className="text-[13px] font-mono font-medium text-[#999] uppercase tracking-wide">Total</p>
              </div>
            </div>

            {/* Task Rows */}
            {uniqueTaskNames.map((task) => (
                <div
                  key={task.id}
                  className="grid grid-cols-[240px_repeat(7,1fr)_80px] border-b border-[#e5e5e5] dark:border-[#222] hover:bg-[#fafafa] dark:hover:bg-[#0f0f0f] transition-colors"
                >
                  <div className="px-5 py-3 flex items-center gap-2 min-w-0">
                    {task.hasTask ? (
                      <>
                        <Link2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                        <span
                          className="text-[13px] font-medium text-[#111] dark:text-[#eee] truncate"
                          title={task.name}
                        >
                          {task.name}
                        </span>
                      </>
                    ) : (
                      <>
                        <FileText className="h-3.5 w-3.5 text-[#bbb] dark:text-[#555] shrink-0" />
                        <span
                          className="text-[13px] italic text-[#666] dark:text-[#888] truncate"
                          title={task.name}
                        >
                          {task.name}
                        </span>
                        <Badge variant="secondary" className="h-4 px-1 text-[9px] font-medium shrink-0">
                          {st('sweep.weldflow.timesheetPage.noTask')}
                        </Badge>
                      </>
                    )}
                  </div>
                  {weekDays.map((day, dayIndex) => {
                    const cellEntries = getEntriesForCell(task.id, day.date);
                    const hours = cellEntries.reduce((s, e) => s + e.duration / 60, 0);
                    const isHovered = hoveredCell?.task === task.id && hoveredCell?.day === dayIndex;

                    const cellClass = cn(
                      "px-2 py-2 flex items-center justify-center border-l border-[#e5e5e5] dark:border-[#222] min-h-[48px] cursor-pointer transition-colors",
                      day.isToday && "bg-blue-50/30 dark:bg-blue-900/5",
                      day.isWeekend && !day.isToday && "bg-[#fafafa] dark:bg-[#0a0a0a]",
                      isHovered && "bg-[#f0f0f0] dark:bg-[#1a1a1a]"
                    );
                    const cellContent = hours > 0 ? (
                      <span className="text-[13px] font-medium tabular-nums text-[#111] dark:text-[#eee]">
                        {hours.toFixed(1)}h
                      </span>
                    ) : isHovered ? (
                      <Plus className="h-4 w-4 text-[#bbb] dark:text-[#555]" />
                    ) : null;

                    if (cellEntries.length === 0) {
                      return (
                        <div
                          key={dayIndex}
                          className={cellClass}
                          onMouseEnter={() => setHoveredCell({ task: task.id, day: dayIndex })}
                          onMouseLeave={() => setHoveredCell(null)}
                          onClick={() => openAddDialogForCell(task.taskId || '', task.name, day.date)}
                        >
                          {cellContent}
                        </div>
                      );
                    }

                    return (
                      <Popover key={dayIndex}>
                        <PopoverTrigger asChild>
                          <div
                            className={cellClass}
                            onMouseEnter={() => setHoveredCell({ task: task.id, day: dayIndex })}
                            onMouseLeave={() => setHoveredCell(null)}
                          >
                            {cellContent}
                          </div>
                        </PopoverTrigger>
                        <PopoverContent align="center" className="w-80 p-0">
                          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                            <div className="min-w-0">
                              <div className="text-[13px] font-medium truncate">{task.name}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {format(day.date, 'EEE, MMM d')} · {hours.toFixed(1)}h total
                              </div>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-[12px]"
                              onClick={() => openAddDialogForCell(task.taskId || '', task.name, day.date)}
                            >
                              <Plus className="h-3.5 w-3.5 mr-1" />
                              {st('sweep.weldflow.timesheetPage.add')}
                            </Button>
                          </div>
                          <div className="max-h-64 overflow-y-auto divide-y divide-border">
                            {cellEntries.map((entry) => (
                              <div key={entry.id} className="px-3 py-2 flex items-start gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[13px] font-semibold tabular-nums">
                                      {(entry.duration / 60).toFixed(2)}h
                                    </span>
                                    {entry.billable && (
                                      <DollarSign className="h-3 w-3 text-emerald-600" />
                                    )}
                                    {entry.status && entry.status !== 'draft' && (
                                      <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                        {entry.status}
                                      </Badge>
                                    )}
                                  </div>
                                  {entry.description && (
                                    <div className="text-[12px] text-muted-foreground mt-0.5 break-words">
                                      {entry.description}
                                    </div>
                                  )}
                                  {entry.userName && (
                                    <div className="text-[11px] text-muted-foreground mt-0.5">
                                      {st('sweep.weldflow.timesheetPage.byUser', { name: entry.userName })}
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center gap-0.5 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    title={st('sweep.weldflow.edit')}
                                    onClick={() => openEditDialog(entry)}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-red-600 hover:text-red-700"
                                    title={st('sweep.weldflow.delete')}
                                    disabled={deletingEntryId === entry.id}
                                    onClick={() => setEntryToDelete(entry)}
                                  >
                                    {deletingEntryId === entry.id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Trash2 className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    );
                  })}
                  <div className="px-2 py-3 flex items-center justify-center border-l border-[#e5e5e5] dark:border-[#222] bg-white dark:bg-[#111]">
                    <span className="text-[13px] font-semibold text-[#111] dark:text-[#eee] tabular-nums">
                      {getTotalHoursForTask(task.id, task.name).toFixed(1)}h
                    </span>
                  </div>
                </div>
              ))}

            {/* Add Task Row */}
            <div className="grid grid-cols-[240px_repeat(7,1fr)_80px] border-b border-[#e5e5e5] dark:border-[#222]">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSelectedDate(new Date());
                  setNewEntryTaskId('');
                  setNewEntryTaskName('');
                  setShowAddDialog(true);
                }}
                className="flex items-center gap-1.5 w-full px-5 py-3 text-left text-[13px] text-[#999] hover:text-foreground hover:bg-muted/50 transition-colors h-auto justify-start rounded-none"
              >
                <Plus className="h-3.5 w-3.5" />
                {st('sweep.weldflow.timesheetPage.addEntry')}
              </Button>
              {weekDays.map((day, index) => (
                <div
                  key={index}
                  className={cn(
                    "border-l border-[#e5e5e5] dark:border-[#222]",
                    day.isToday && "bg-blue-50/30 dark:bg-blue-900/5",
                    day.isWeekend && !day.isToday && "bg-[#fafafa] dark:bg-[#0a0a0a]"
                  )}
                />
              ))}
              <div className="border-l border-[#e5e5e5] dark:border-[#222] bg-white dark:bg-[#111]" />
            </div>
          </div>
        ) : (
          /* Monthly Calendar View */
          <div className="flex flex-col h-full">
            {/* Calendar Header - Desktop */}
            <div className="hidden md:grid grid-cols-7 border-b border-[#e5e5e5] dark:border-[#222]">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => (
                <div
                  key={index}
                  className={cn(
                    "text-center py-2 text-[11px] font-medium uppercase tracking-wide",
                    index >= 5 ? "text-[#bbb] dark:text-[#555]" : "text-[#666] dark:text-[#888]",
                    index > 0 && "border-l border-[#e5e5e5] dark:border-[#222]"
                  )}
                >
                  {day}
                </div>
              ))}
            </div>

            {/* Calendar Grid - Desktop */}
            <div className="hidden md:flex flex-1 flex-col bg-white dark:bg-[#111]">
              {monthWeeks.map((week, weekIndex) => (
                <div
                  key={weekIndex}
                  className={cn(
                    "grid grid-cols-7 flex-1",
                    weekIndex > 0 && "border-t border-[#e5e5e5] dark:border-[#222]"
                  )}
                >
                  {week.map((day, dayIndex) => {
                    const isCurrentMonth = day.date.getMonth() === currentMonth.getMonth();
                    const totalHours = getTotalHoursForDate(day.date);
                    const dayEntries = entries.filter(entry => {
                      const entryDate = new Date(entry.date);
                      entryDate.setHours(0, 0, 0, 0);
                      const targetDate = new Date(day.date);
                      targetDate.setHours(0, 0, 0, 0);
                      return entryDate.getTime() === targetDate.getTime();
                    });

                    return (
                      <div
                        key={dayIndex}
                        className={cn(
                          "px-2.5 py-2 cursor-pointer transition-colors group flex flex-col",
                          dayIndex > 0 && "border-l border-[#e5e5e5] dark:border-[#222]",
                          !isCurrentMonth && "bg-[#fafafa] dark:bg-[#0a0a0a]",
                          day.isToday && "bg-blue-50/50 dark:bg-blue-900/10",
                          day.isWeekend && isCurrentMonth && !day.isToday && "bg-[#fcfcfc] dark:bg-[#0d0d0d]",
                          "hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]"
                        )}
                        onClick={() => {
                          setSelectedDate(day.date);
                          setShowAddDialog(true);
                        }}
                      >
                        {/* Day Number */}
                        <div className="flex items-center justify-between mb-2">
                          <span className={cn(
                            "text-[13px] font-medium",
                            day.isToday
                              ? "text-white bg-blue-600 dark:bg-blue-500 w-6 h-6 rounded-full flex items-center justify-center"
                              : isCurrentMonth
                                ? "text-[#111] dark:text-[#eee]"
                                : "text-[#bbb] dark:text-[#555]"
                          )}>
                            {day.dayNumber}
                          </span>
                          {totalHours > 0 && (
                            <span className={cn(
                              "text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded",
                              totalHours >= 8
                                ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                                : "text-[#666] dark:text-[#888] bg-[#f0f0f0] dark:bg-[#222]"
                            )}>
                              {totalHours.toFixed(1)}h
                            </span>
                          )}
                        </div>

                        {/* Entries */}
                        <div className="space-y-1">
                          {dayEntries.slice(0, 3).map((entry) => (
                            <div
                              key={entry.id}
                              className={cn(
                                "text-[11px] px-1.5 py-0.5 rounded truncate",
                                entry.duration >= 240
                                  ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400"
                                  : "bg-[#f5f5f5] dark:bg-[#1a1a1a] text-[#666] dark:text-[#888]"
                              )}
                            >
                              <span className="font-medium">{(entry.duration / 60).toFixed(1)}h</span>
                              <span className="ml-1">{entry.taskName}</span>
                            </div>
                          ))}
                          {dayEntries.length > 3 && (
                            <div className="text-[10px] text-[#999] dark:text-[#666] px-1.5">
                              +{dayEntries.length - 3} more
                            </div>
                          )}
                        </div>

                        {/* Add button on hover */}
                        {dayEntries.length === 0 && (
                          <div className="flex-1 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity mt-4">
                            <Plus className="h-5 w-5 text-[#ccc] dark:text-[#444]" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Mobile Month View - List of days */}
            <div className="md:hidden flex-1 overflow-auto bg-white dark:bg-[#111]">
              {monthWeeks.flat().filter(day => day.date.getMonth() === currentMonth.getMonth()).map((day, index) => {
                const totalHours = getTotalHoursForDate(day.date);
                const dayEntries = entries.filter(entry => {
                  const entryDate = new Date(entry.date);
                  entryDate.setHours(0, 0, 0, 0);
                  const targetDate = new Date(day.date);
                  targetDate.setHours(0, 0, 0, 0);
                  return entryDate.getTime() === targetDate.getTime();
                });

                return (
                  <div
                    key={index}
                    className={cn(
                      "px-4 py-3 border-b border-[#e5e5e5] dark:border-[#222] cursor-pointer",
                      day.isToday && "bg-blue-50/50 dark:bg-blue-900/10",
                      day.isWeekend && !day.isToday && "bg-[#fafafa] dark:bg-[#0a0a0a]",
                      "active:bg-[#f0f0f0] dark:active:bg-[#1a1a1a]"
                    )}
                    onClick={() => {
                      setSelectedDate(day.date);
                      setShowAddDialog(true);
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "w-10 h-10 rounded-lg flex flex-col items-center justify-center",
                          day.isToday
                            ? "bg-blue-600 dark:bg-blue-500 text-white"
                            : "bg-[#f5f5f5] dark:bg-[#1a1a1a]"
                        )}>
                          <span className="text-[10px] font-medium uppercase">
                            {format(day.date, 'EEE')}
                          </span>
                          <span className="text-[15px] font-semibold -mt-0.5">
                            {day.dayNumber}
                          </span>
                        </div>
                        <div>
                          <p className={cn(
                            "text-[13px] font-medium",
                            day.isToday ? "text-blue-600 dark:text-blue-400" : "text-[#111] dark:text-[#eee]"
                          )}>
                            {format(day.date, 'MMMM d, yyyy')}
                          </p>
                          {dayEntries.length > 0 && (
                            <p className="text-[12px] text-[#666] dark:text-[#888]">
                              {dayEntries.length} {dayEntries.length === 1 ? 'entry' : 'entries'}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {totalHours > 0 && (
                          <span className={cn(
                            "text-[13px] font-semibold tabular-nums px-2 py-1 rounded",
                            totalHours >= 8
                              ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                              : "text-[#666] dark:text-[#888] bg-[#f0f0f0] dark:bg-[#222]"
                          )}>
                            {totalHours.toFixed(1)}h
                          </span>
                        )}
                        <Plus className="h-4 w-4 text-[#ccc] dark:text-[#555]" />
                      </div>
                    </div>
                    {/* Show entries preview */}
                    {dayEntries.length > 0 && (
                      <div className="mt-2 pl-[52px] space-y-1">
                        {dayEntries.slice(0, 2).map((entry) => (
                          <div
                            key={entry.id}
                            className={cn(
                              "text-[12px] px-2 py-1 rounded truncate",
                              entry.duration >= 240
                                ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400"
                                : "bg-[#f5f5f5] dark:bg-[#1a1a1a] text-[#666] dark:text-[#888]"
                            )}
                          >
                            <span className="font-medium">{(entry.duration / 60).toFixed(1)}h</span>
                            <span className="ml-1.5">{entry.taskName}</span>
                          </div>
                        ))}
                        {dayEntries.length > 2 && (
                          <p className="text-[11px] text-[#999] dark:text-[#666]">
                            +{dayEntries.length - 2} more
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Calculations Footer - Fixed at bottom */}
      {viewMode === 'week' && (
        <div className="border-t bg-white dark:bg-background">
          <div className="grid grid-cols-[240px_repeat(7,1fr)_80px] min-w-[900px]">
            <div className="px-5 py-2 text-sm text-gray-500 dark:text-muted-foreground">Daily Total</div>
            {weekDays.map((day, index) => {
              const dayTotal = getTotalHoursForDate(day.date);
              return (
                <div key={index} className="pl-4 pr-2 py-2 text-sm text-gray-500 dark:text-muted-foreground text-left border-l border-[#e5e5e5] dark:border-[#222]">
                  <span className="font-medium">{dayTotal > 0 ? `${dayTotal.toFixed(1)}h` : '—'}</span>
                </div>
              );
            })}
            <div className="px-2 py-2 text-sm font-medium text-gray-700 dark:text-muted-foreground text-center border-l border-[#e5e5e5] dark:border-[#222]">
              {weeklyTotal.toFixed(1)}h
            </div>
          </div>
        </div>
      )}

      {/* Add Entry Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => {
        setShowAddDialog(open);
        if (!open) setEditingEntryId(null);
      }}>
        <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden" showCloseButton={false}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-border">
            <DialogTitle className="text-base font-semibold">{editingEntryId ? 'Edit time entry' : 'Log time'}</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 translate-x-[4px] hover:ring-[3px] hover:ring-accent dark:hover:ring-accent"
              onClick={() => setShowAddDialog(false)}
            >
              <X className="h-3.5 w-3.5 !text-gray-500 dark:!text-gray-400" strokeWidth={2.5} />
            </Button>
          </div>

          {/* Description row — prominent, optional (like the title row in Create task). */}
          <div className="pl-4 py-[11px]">
            <textarea
              value={newEntryDescription}
              onChange={(e) => {
                setNewEntryDescription(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const hasDuration =
                    !!newEntryHours ||
                    !!newEntryMinutes ||
                    minutesFromRange(newEntryStartTime, newEntryEndTime) !== null;
                  if (hasDuration && selectedDate && !isSubmitting) handleAddEntry();
                }
              }}
              placeholder={st('sweep.weldflow.timesheetPage.addDescriptionPlaceholder')}
              className="w-full pl-0 pr-4 py-0 m-0 text-sm font-medium border-none outline-none bg-transparent placeholder:text-gray-400 resize-none overflow-y-auto max-h-[200px] min-h-[20px] leading-5 align-top block break-words [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
              rows={1}
              autoFocus
            />
          </div>

          <div className="border-b border-gray-100 dark:border-border" />

          {/* Task selector row — optional secondary link (like the description row in Create task). */}
          <div className="px-4 py-[11px] group relative min-w-0">
            <Popover
              open={taskSelectorOpen}
              onOpenChange={(open) => {
                setTaskSelectorOpen(open);
                if (!open) setTaskSearchQuery('');
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(
                    'w-full text-left text-sm text-gray-600 dark:text-muted-foreground border-none outline-none bg-transparent block break-words truncate leading-5 min-h-[20px] h-auto p-0 font-normal justify-start',
                    !newEntryTaskName && 'text-gray-400',
                  )}
                >
                  {newEntryTaskName || 'Link a task (optional)...'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[280px] p-0" align="start">
                <div className="flex items-center border-b px-3">
                  <Search className="mr-0.5 h-4 w-4 shrink-0 opacity-50" />
                  <input
                    placeholder={st('sweep.weldflow.tasksView.searchPlaceholder')}
                    value={taskSearchQuery}
                    onChange={(e) => setTaskSearchQuery(e.target.value)}
                    className="flex h-9 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <div
                  className="max-h-[200px] overflow-y-auto p-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
                  onWheel={(e) => e.stopPropagation()}
                >
                  {filteredTasks.length === 0 ? (
                    <div className="py-4 text-center text-sm text-muted-foreground">No tasks found.</div>
                  ) : (
                    filteredTasks.map((task) => (
                      <div
                        key={task.id}
                        onClick={() => {
                          setNewEntryTaskId(task.id);
                          setNewEntryTaskName(task.title);
                          setTaskSelectorOpen(false);
                          setTaskSearchQuery('');
                        }}
                        className={cn(
                          'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground',
                          newEntryTaskId === task.id && 'bg-accent text-accent-foreground',
                        )}
                      >
                        <span className="truncate">{task.title}</span>
                        {newEntryTaskId === task.id && (
                          <Check className="ml-auto h-4 w-4 flex-shrink-0" />
                        )}
                      </div>
                    ))
                  )}
                </div>
                <div className="border-t border-gray-200 dark:border-border p-1">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setTaskSelectorOpen(false);
                      setShowAddDialog(false);
                      setShowCreateTaskDialog(true);
                    }}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left hover:bg-accent rounded gap-1.5 h-auto justify-start font-normal"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {st('sweep.weldflow.timesheetPage.createNewTask')}
                  </Button>
                </div>
                {newEntryTaskId && (
                  <div className="border-t border-gray-200 dark:border-border p-1">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setNewEntryTaskId('');
                        setNewEntryTaskName('');
                      }}
                      className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto justify-start font-normal"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      {st('sweep.weldflow.timesheetPage.clear')}
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {/* Bottom Bar */}
          <div className="flex items-end justify-between px-4 py-2 border-t border-gray-100 dark:border-border gap-2 w-full">
            <div className="flex items-center gap-1 flex-wrap min-w-0 flex-shrink py-2.5">
                  {/* Duration (hours + minutes) */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          'h-7 text-xs font-normal',
                          (newEntryHours || newEntryMinutes) &&
                            'bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800',
                        )}
                      >
                        {(() => {
                          const ranged = minutesFromRange(newEntryStartTime, newEntryEndTime);
                          const total =
                            ranged ??
                            (parseInt(newEntryHours || '0', 10) || 0) * 60 +
                              (parseInt(newEntryMinutes || '0', 10) || 0);
                          const h = Math.floor(total / 60);
                          const m = total % 60;
                          if (!h && !m) return 'Duration';
                          if (h && m) return `${h}h ${m}m`;
                          if (h) return `${h}h`;
                          return `${m}m`;
                        })()}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-3" align="start">
                      <div className="flex items-end gap-2">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs font-medium text-muted-foreground">Hours</label>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            placeholder="0"
                            value={newEntryHours}
                            onChange={(e) => setNewEntryHours(e.target.value)}
                            className="w-20 h-8 text-sm"
                            disabled={minutesFromRange(newEntryStartTime, newEntryEndTime) !== null}
                            autoFocus
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs font-medium text-muted-foreground">Minutes</label>
                          <Input
                            type="number"
                            min="0"
                            max="59"
                            step="1"
                            placeholder="0"
                            value={newEntryMinutes}
                            onChange={(e) => setNewEntryMinutes(e.target.value)}
                            className="w-20 h-8 text-sm"
                            disabled={minutesFromRange(newEntryStartTime, newEntryEndTime) !== null}
                          />
                        </div>
                      </div>
                      {minutesFromRange(newEntryStartTime, newEntryEndTime) !== null && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {tt.durationFromRange}
                        </p>
                      )}
                    </PopoverContent>
                  </Popover>

                  {/* Start / end clock times. Optional — leave blank to log a
                      bare duration. Setting both drives the duration instead. */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          'h-7 text-xs font-normal',
                          (newEntryStartTime || newEntryEndTime) &&
                            'bg-sky-100 text-sky-800 border-sky-200 hover:bg-sky-200 dark:bg-sky-900/30 dark:text-sky-400 dark:border-sky-800',
                        )}
                      >
                        {newEntryStartTime && newEntryEndTime
                          ? `${newEntryStartTime} – ${newEntryEndTime}`
                          : newEntryStartTime || newEntryEndTime || tt.startEndRange}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-3" align="start">
                      <div className="flex items-end gap-2">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs font-medium text-muted-foreground">{tt.startTimeLabel}</label>
                          <Input
                            type="time"
                            value={newEntryStartTime}
                            onChange={(e) => setNewEntryStartTime(e.target.value)}
                            className="w-28 h-8 text-sm"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs font-medium text-muted-foreground">{tt.endTimeLabel}</label>
                          <Input
                            type="time"
                            value={newEntryEndTime}
                            onChange={(e) => setNewEntryEndTime(e.target.value)}
                            className="w-28 h-8 text-sm"
                          />
                        </div>
                      </div>
                      {newEntryStartTime &&
                        newEntryEndTime &&
                        minutesFromRange(newEntryStartTime, newEntryEndTime) === null && (
                          <p className="mt-2 text-xs text-destructive">{tt.endAfterStart}</p>
                        )}
                      {(newEntryStartTime || newEntryEndTime) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-7 w-full justify-start px-2 text-xs font-normal text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                          onClick={() => {
                            setNewEntryStartTime('');
                            setNewEntryEndTime('');
                          }}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          {tt.clearTimes}
                        </Button>
                      )}
                    </PopoverContent>
                  </Popover>

                  {/* Date */}
                  <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 text-xs font-normal">
                        {selectedDate ? format(selectedDate, 'MMM d') : 'Date'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={selectedDate || undefined}
                        captionLayout="dropdown"
                        month={datePickerMonth || selectedDate || new Date()}
                        onMonthChange={setDatePickerMonth}
                        onSelect={(date) => {
                          setSelectedDate(date || null);
                          setDatePickerOpen(false);
                        }}
                      />
                      {selectedDate && (
                        <div className="p-1 border-t border-gray-200 dark:border-border">
                          <Button
                            variant="ghost"
                            onClick={() => setSelectedDate(null)}
                            className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto justify-start font-normal"
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" />
                            {st('sweep.weldflow.timesheetPage.clear')}
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>

                  {/* Round to */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          "h-7 text-xs font-normal",
                          newEntryRoundTo !== 'none' && "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800"
                        )}
                      >
                        {newEntryRoundTo !== 'none' ? `Round ${newEntryRoundTo}m` : 'Round'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-1" align="start">
                      {[
                        { value: 'none', label: 'No rounding' },
                        { value: '5', label: '5 min' },
                        { value: '10', label: '10 min' },
                        { value: '15', label: '15 min' },
                        { value: '30', label: '30 min' },
                        { value: '60', label: '1 hour' },
                      ].map((opt) => (
                        <Button
                          key={opt.value}
                          variant="ghost"
                          onClick={() => setNewEntryRoundTo(opt.value)}
                          className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded h-auto font-normal"
                        >
                          <span>{opt.label}</span>
                          {newEntryRoundTo === opt.value && <Check className="h-3.5 w-3.5 text-primary" />}
                        </Button>
                      ))}
                    </PopoverContent>
                  </Popover>

                  {/* Billable */}
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-7 text-xs font-normal",
                      newEntryBillable && "bg-green-100 text-green-800 border-green-200 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
                    )}
                    onClick={() => setNewEntryBillable(!newEntryBillable)}
                  >
                    {newEntryBillable ? st('sweep.weldflow.timesheetPage.billable') : st('sweep.weldflow.timesheetPage.notBillable')}
                  </Button>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0 py-2.5">
                  {(() => {
                    const missing: string[] = [];
                    const mins =
                      minutesFromRange(newEntryStartTime, newEntryEndTime) ??
                      (parseInt(newEntryHours || '0', 10) || 0) * 60 +
                        (parseInt(newEntryMinutes || '0', 10) || 0);
                    if (!mins) missing.push('Duration');
                    if (!selectedDate) missing.push('Date');
                    const disabled = isSubmitting || !mins || !selectedDate;
                    const btn = (
                      <Button
                        size="sm"
                        onClick={handleAddEntry}
                        disabled={disabled}
                        className="h-[30px] text-xs px-3 bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        {isSubmitting ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'Log time'
                        )}
                      </Button>
                    );
                    if (missing.length === 0) return btn;
                    // Radix tooltip doesn't hover over disabled elements, so
                    // wrap the button in a span (the trigger) to capture the
                    // pointer events.
                    return (
                      <Tooltip delayDuration={300}>
                        <TooltipTrigger asChild>
                          <span className="inline-flex">{btn}</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={6}>
                          Missing: {missing.join(', ')}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })()}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Start Timer Dialog */}
      <Dialog open={showTimerDialog} onOpenChange={setShowTimerDialog}>
        <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden" showCloseButton={false}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-border">
            <DialogTitle className="text-base font-semibold">Start timer</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setShowTimerDialog(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Content */}
          <div className="px-4 pt-3 pb-[7px]">
            <textarea
              value={timerDescription}
              onChange={(e) => {
                setTimerDescription(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if ((timerTaskName || timerTaskId)) startTimer();
                }
              }}
              placeholder={st('sweep.weldflow.timesheetPage.addDescriptionPlaceholder')}
              className="w-full text-sm text-gray-600 dark:text-muted-foreground border-none outline-none bg-transparent placeholder:text-gray-400 resize-none overflow-y-auto max-h-[200px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
              rows={2}
              autoFocus
            />
          </div>

          {/* Bottom Bar */}
          <div className="flex items-center justify-between px-4 pt-0 pb-0 border-t border-gray-100 dark:border-border gap-2 w-full overflow-hidden">
            <div className="flex items-center gap-1 overflow-x-auto min-w-0 flex-shrink pb-7 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent [&>*]:flex-shrink-0 [&>*]:translate-y-[14px]">
              {/* Task */}
              <Popover open={timerTaskSelectorOpen} onOpenChange={(open) => {
                setTimerTaskSelectorOpen(open);
                if (!open) setTimerTaskSearchQuery('');
              }}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-7 text-xs font-normal max-w-[160px] truncate",
                      timerTaskName && "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800"
                    )}
                  >
                    {timerTaskName || 'Task'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-0" align="start">
                  <div className="flex items-center border-b px-3">
                    <Search className="mr-0.5 h-4 w-4 shrink-0 opacity-50" />
                    <input
                      placeholder={st('sweep.weldflow.tasksView.searchPlaceholder')}
                      value={timerTaskSearchQuery}
                      onChange={(e) => setTimerTaskSearchQuery(e.target.value)}
                      className="flex h-9 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                  <div
                    className="max-h-[200px] overflow-y-auto p-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
                    onWheel={(e) => e.stopPropagation()}
                  >
                    {filteredTimerTasks.length === 0 ? (
                      <div className="py-4 text-center text-sm text-muted-foreground">No tasks found.</div>
                    ) : (
                      filteredTimerTasks.map((task) => (
                        <div
                          key={task.id}
                          onClick={() => {
                            setTimerTaskId(task.id);
                            setTimerTaskName(task.title);
                            setTimerTaskSelectorOpen(false);
                            setTimerTaskSearchQuery('');
                          }}
                          className={cn(
                            "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                            timerTaskId === task.id && "bg-accent text-accent-foreground"
                          )}
                        >
                          <span className="truncate">{task.title}</span>
                          {timerTaskId === task.id && (
                            <Check className="ml-auto h-4 w-4 flex-shrink-0" />
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  {timerTaskId && (
                    <div className="border-t border-gray-200 dark:border-border p-1">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setTimerTaskId('');
                          setTimerTaskName('');
                        }}
                        className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto justify-start font-normal"
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        {st('sweep.weldflow.timesheetPage.clear')}
                      </Button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>

              {/* Round to */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-7 text-xs font-normal",
                      timerRoundTo !== 'none' && "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800"
                    )}
                  >
                    {timerRoundTo !== 'none' ? `Round ${timerRoundTo}m` : 'Round'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-1" align="start">
                  {[
                    { value: 'none', label: 'No rounding' },
                    { value: '5', label: '5 min' },
                    { value: '10', label: '10 min' },
                    { value: '15', label: '15 min' },
                    { value: '30', label: '30 min' },
                    { value: '60', label: '1 hour' },
                  ].map((opt) => (
                    <Button
                      key={opt.value}
                      variant="ghost"
                      onClick={() => setTimerRoundTo(opt.value)}
                      className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded h-auto font-normal"
                    >
                      <span>{opt.label}</span>
                      {timerRoundTo === opt.value && <Check className="h-3.5 w-3.5 text-primary" />}
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>

              {/* Billable */}
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 text-xs font-normal",
                  timerBillable && "bg-green-100 text-green-800 border-green-200 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
                )}
                onClick={() => setTimerBillable(!timerBillable)}
              >
                {timerBillable ? st('sweep.weldflow.timesheetPage.billable') : st('sweep.weldflow.timesheetPage.notBillable')}
              </Button>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                size="sm"
                onClick={startTimer}
                disabled={!timerTaskName && !timerTaskId}
                className="h-7 text-xs px-3 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {st('sweep.weldflow.timesheetPage.startTimer')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Task Dialog — same shared TaskDialog used on the tasks page. */}
      <TaskDialog
        open={showCreateTaskDialog}
        onOpenChange={(open) => {
          setShowCreateTaskDialog(open);
          if (!open) setShowAddDialog(true);
        }}
        editingTask={null}
        availableAssignees={projectMembers
          .filter((m) => m.user?.name)
          .map((m) => ({ id: m.userId, name: m.user!.name, avatar: m.user?.avatar }))}
        availableCompanies={[]}
        hideRecord
        projectId={projectId}
        onSave={handleTaskDialogSave}
        onUpdate={() => {}}
        isPending={isCreatingTask}
      />

      <ConfirmDialog
        open={!!entryToDelete}
        onOpenChange={(open) => {
          if (!open) setEntryToDelete(null);
        }}
        title={st('sweep.weldflow.timesheetPage.deleteTimeEntryTitle')}
        description={
          entryToDelete ? (
            <>
              {st('sweep.weldflow.timesheetPage.deleteTimeEntryWillRemove')}{' '}
              <span className="font-medium">
                {(entryToDelete.duration / 60).toFixed(2)}h
              </span>
              {entryToDelete.task?.title ? (
                <>
                  {' '}{st('sweep.weldflow.timesheetPage.onConnector')} <span className="font-medium">{entryToDelete.task.title}</span>
                </>
              ) : entryToDelete.description ? (
                <> — <span className="font-medium">{entryToDelete.description}</span></>
              ) : null}
              {' '}({format(entryToDelete.date, 'EEE, MMM d')}). {st('sweep.weldflow.timesheetPage.actionCannotBeUndone')}
            </>
          ) : null
        }
        confirmLabel={st('sweep.weldflow.delete')}
        variant="destructive"
        loading={deletingEntryId === entryToDelete?.id}
        onConfirm={async () => {
          if (!entryToDelete) return;
          await handleDeleteEntry(entryToDelete.id);
          setEntryToDelete(null);
        }}
      />
    </div>
  );
}
