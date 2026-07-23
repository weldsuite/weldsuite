
import {
  GanttCreateMarkerTrigger,
  GanttFeatureItem,
  GanttFeatureList,
  GanttFeatureListGroup,
  GanttHeader,
  GanttMarker,
  GanttProvider,
  GanttSidebar,
  GanttSidebarGroup,
  GanttSidebarItem,
  GanttTimeline,
  GanttToday,
  GanttTreeView,
} from '@weldsuite/ui/components/gantt';
import { CalendarDays, CalendarIcon, CalendarRange, Check, ChevronDown, EyeIcon, LinkIcon, Milestone, MinusIcon, PencilIcon, PlusIcon, Search, SquarePen, TrashIcon, Trash2 } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { Separator } from '@weldsuite/ui/components/separator';
import { Calendar as CalendarPicker } from '@weldsuite/ui/components/calendar';
import { toast } from 'sonner';
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { useParams } from '@/lib/router';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@weldsuite/ui/components/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Badge } from '@weldsuite/ui/components/badge';
import { Slider } from '@weldsuite/ui/components/slider';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '@weldsuite/ui/components/context-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import { ganttApi, tasksApi, membersApi, labelsApi } from '@/app/weldflow/lib/api-client';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { type TaskComment } from '@/components/task-detail';
import { useObjectPanel } from '@/components/object-panel';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
import { useAuth } from '@clerk/clerk-react';
import { useI18n } from '@/lib/i18n/provider';

const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);

// Status configurations with colors
const statusConfig: Record<string, { name: string; color: string }> = {
  backlog: { name: 'Backlog', color: '#94a3b8' },      // slate-400
  todo: { name: 'To Do', color: '#c4b5fd' },           // purple-300
  in_progress: { name: 'In Progress', color: '#93c5fd' }, // blue-300
  in_review: { name: 'In Review', color: '#fcd34d' },  // amber-300
  testing: { name: 'Testing', color: '#fdba74' },      // orange-300
  done: { name: 'Done', color: '#5eead4' },            // teal-300
  cancelled: { name: 'Cancelled', color: '#fca5a5' },  // red-300
};

// Priority colors — reference Tailwind CSS vars so the bar area + text match the label pills
// exactly (bg-{color}-100 area + text-{color}-600 text). Using hex literals would drift from
// Tailwind v4's OKLCH values; var(--color-*) guarantees a pixel-perfect match.
const priorityBgColors: Record<string, string> = {
  low: 'var(--color-gray-200)',
  medium: 'var(--color-blue-100)',
  high: 'var(--color-orange-100)',
  urgent: 'var(--color-red-100)',
  critical: 'var(--color-red-100)',
};
const priorityTextColors: Record<string, string> = {
  low: 'var(--color-gray-600)',
  medium: 'var(--color-blue-600)',
  high: 'var(--color-orange-600)',
  urgent: 'var(--color-red-600)',
  critical: 'var(--color-red-600)',
};
const NO_PRIORITY_BG = 'var(--color-gray-200)';
const NO_PRIORITY_TEXT = 'var(--color-gray-600)';

const statuses = Object.entries(statusConfig).map(([id, config]) => ({
  id,
  name: config.name,
  color: config.color,
}));

const markerColors = [
  { name: 'Blue', className: 'bg-blue-100 text-blue-900', color: '#dbeafe' },
  { name: 'Green', className: 'bg-green-100 text-green-900', color: '#dcfce7' },
  { name: 'Purple', className: 'bg-purple-100 text-purple-900', color: '#f3e8ff' },
  { name: 'Red', className: 'bg-red-100 text-red-900', color: '#fee2e2' },
  { name: 'Orange', className: 'bg-orange-100 text-orange-900', color: '#ffedd5' },
  { name: 'Teal', className: 'bg-teal-100 text-teal-900', color: '#ccfbf1' },
  { name: 'Yellow', className: 'bg-yellow-100 text-yellow-900', color: '#fef9c3' },
  { name: 'Pink', className: 'bg-pink-100 text-pink-900', color: '#fce7f3' },
];

// Milestone status to color mapping
const milestoneStatusColors: Record<string, string> = {
  planned: 'bg-purple-100 text-purple-900',
  pending: 'bg-yellow-100 text-yellow-900',
  in_progress: 'bg-blue-100 text-blue-900',
  completed: 'bg-green-100 text-green-900',
  missed: 'bg-red-100 text-red-900',
  postponed: 'bg-orange-100 text-orange-900',
};

// Feature type for Gantt (mapped from Task)
interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

interface GanttFeature {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  status: { id: string; name: string; color: string };
  owner?: { id: string; name: string; image?: string };
  group: { id: string; name: string };
  priority?: string;
  taskKey?: string;
  originalTask?: any;
  parentTaskId?: string;
  isSubtask?: boolean;
  subtasks?: GanttFeature[];
  labels?: string[];
}

// Marker type for Gantt (mapped from Milestone)
interface GanttMarkerType {
  id: string;
  date: Date;
  label: string;
  className: string;
  originalMilestone?: any;
}

// Map API task to Gantt feature format
function mapTaskToFeature(task: any, isSubtask: boolean = false): GanttFeature {
  const startDate = task.startDate ? new Date(task.startDate) : new Date();
  const endDate = task.dueDate ? new Date(task.dueDate) : new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000); // Default 7 days

  const statusKey = task.status || 'todo';
  const statusInfo = statusConfig[statusKey] || statusConfig.todo;

  // Group by status (could also group by sprint, milestone, or assignee)
  const groupName = statusInfo.name;

  return {
    id: task.id,
    name: task.title || 'Untitled Task',
    startAt: startDate,
    endAt: endDate,
    status: {
      id: statusKey,
      name: statusInfo.name,
      color: (task.priority && priorityBgColors[task.priority]) || NO_PRIORITY_BG,
      textColor: (task.priority && priorityTextColors[task.priority]) || NO_PRIORITY_TEXT,
    },
    owner: task.assignee ? {
      id: task.assignee.id || task.assigneeId,
      name: task.assignee.name || task.assigneeName || 'Unknown',
      image: task.assignee.avatar || task.assignee.image,
    } : undefined,
    group: {
      id: statusKey,
      name: groupName,
    },
    priority: task.priority,
    taskKey: task.key,
    originalTask: task,
    parentTaskId: task.parentTaskId,
    isSubtask,
    labels: task.labels || undefined,
  };
}

// Organize tasks into parent-child hierarchy
function organizeTasksWithSubtasks(tasks: any[]): GanttFeature[] {
  // Create a map of all tasks
  const taskMap = new Map<string, any>();
  tasks.forEach(task => taskMap.set(task.id, task));

  // Separate parent tasks and subtasks
  const parentTasks: any[] = [];
  const subtasksByParent = new Map<string, any[]>();

  tasks.forEach(task => {
    if (task.parentTaskId && taskMap.has(task.parentTaskId)) {
      // This is a subtask
      const existing = subtasksByParent.get(task.parentTaskId) || [];
      existing.push(task);
      subtasksByParent.set(task.parentTaskId, existing);
    } else {
      // This is a parent task (or standalone task)
      parentTasks.push(task);
    }
  });

  // Map parent tasks with their subtasks - keep them together in the same group
  const features: GanttFeature[] = [];

  parentTasks.forEach(task => {
    // Only include tasks with dates
    if (task.startDate || task.dueDate) {
      const parentFeature = mapTaskToFeature(task, false);
      const childTasks = subtasksByParent.get(task.id) || [];

      // Map subtasks that have dates - use parent's group so they stay together
      const subtaskFeatures = childTasks
        .filter((subtask: any) => subtask.startDate || subtask.dueDate)
        .map((subtask: any) => {
          const subtaskFeature = mapTaskToFeature(subtask, true);
          // Use parent's group so subtasks are grouped with parent
          subtaskFeature.group = parentFeature.group;
          return subtaskFeature;
        });

      parentFeature.subtasks = subtaskFeatures;
      features.push(parentFeature);

      // Also add subtasks as separate features right after parent for the Gantt chart display
      subtaskFeatures.forEach(subtask => {
        features.push(subtask);
      });
    }
  });

  return features;
}

// Map API milestone to Gantt marker format
function mapMilestoneToMarker(milestone: any): GanttMarkerType {
  const dueDate = milestone.dueDate ? new Date(milestone.dueDate) : new Date();
  const statusClass = milestoneStatusColors[milestone.status] || milestoneStatusColors.planned;

  return {
    id: milestone.id,
    date: dueDate,
    label: milestone.name || 'Untitled Milestone',
    className: statusClass,
    originalMilestone: milestone,
  };
}

// Sidebar item component with context menu and highlight state
const SidebarItemWithContextMenu = ({
  feature,
  onView,
  onRename,
  onCopyLink,
  onRemove,
  onAddSubtask,
}: {
  feature: GanttFeature;
  onView: (id: string) => void;
  onRename: (id: string) => void;
  onCopyLink: (id: string) => void;
  onRemove: (id: string) => void;
  onAddSubtask: (parentId: string) => void;
}) => {
  const { t } = useI18n();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <ContextMenu onOpenChange={setIsMenuOpen}>
      <ContextMenuTrigger asChild>
        <div className={isMenuOpen ? 'bg-muted rounded-sm' : ''}>
          <GanttSidebarItem
            feature={feature}
            onSelectItem={onView}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          className="flex items-center gap-2"
          onClick={() => onView(feature.id)}
        >
          <EyeIcon className="text-muted-foreground" size={16} />
          {t.projects.gantt.viewTask}
        </ContextMenuItem>
        <ContextMenuItem
          className="flex items-center gap-2"
          onClick={() => onRename(feature.id)}
        >
          <PencilIcon className="text-muted-foreground" size={16} />
          {t.projects.gantt.rename}
        </ContextMenuItem>
        <ContextMenuItem
          className="flex items-center gap-2"
          onClick={() => onCopyLink(feature.id)}
        >
          <LinkIcon className="text-muted-foreground" size={16} />
          {t.projects.gantt.copyLink}
        </ContextMenuItem>
        {!feature.isSubtask && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="flex items-center gap-2"
              onClick={() => onAddSubtask(feature.id)}
            >
              <PlusIcon className="text-muted-foreground" size={16} />
              {t.projects.gantt.addSubtask}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          className="flex items-center gap-2 text-destructive"
          onClick={() => onRemove(feature.id)}
        >
          <TrashIcon size={16} className="text-destructive" />
          {t.projects.gantt.removeFromRoadmap}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

const GanttPage = () => {
  const params = useParams();
  const projectId = params.projectId as string;
  const { canWrite } = useProjectPermissions();
  const { t } = useI18n();

  const [features, setFeatures] = useState<GanttFeature[]>([]);
  const [markers, setMarkers] = useState<GanttMarkerType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameMarkerDialogOpen, setRenameMarkerDialogOpen] = useState(false);
  const [viewSheetOpen, setViewSheetOpen] = useState(false);
  const [viewMarkerPopoverOpen, setViewMarkerPopoverOpen] = useState(false);
  const [markerPopoverPosition, setMarkerPopoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<GanttFeature | null>(null);
  // The task detail panel is now rendered globally via ObjectPanelHost.
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

  // Keep selectedFeature in sync when features list updates (e.g. after save)
  useEffect(() => {
    if (selectedFeature) {
      const updated = features.find(f => f.id === selectedFeature.id);
      if (updated && updated !== selectedFeature) {
        setSelectedFeature(updated);
      }
    }
  }, [features]);

  const [selectedMarker, setSelectedMarker] = useState<GanttMarkerType | null>(null);
  const [markerDatePickerOpen, setMarkerDatePickerOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [viewMode, setViewMode] = useState<'daily' | 'weekly' | 'monthly' | 'quarterly'>('monthly');
  // Each view has its own "100% focus" zoom that tunes the column widths
  // for that level. The user-facing `zoomLevel` is always relative to that
  // baseline — 100% means "standard focus for this view", and the +/- buttons
  // step in 25% increments around it.
  const VIEW_BASELINE_ZOOM: Record<typeof viewMode, number> = {
    daily: 320,
    // Weekly now has its own range (1 column = 1 week, base width 100px).
    // 150 gives ~150px per week column.
    weekly: 150,
    monthly: 100,
    quarterly: 200,
  };
  const [zoomLevel, setZoomLevel] = useState(100);
  const effectiveZoom = (VIEW_BASELINE_ZOOM[viewMode] * zoomLevel) / 100;
  const handleViewModeChange = useCallback(
    (mode: typeof viewMode) => {
      setViewMode(mode);
      setZoomLevel(100);
    },
    [],
  );

  // Snap the "Today" line to the 20% mark of the visible timeline whenever
  // the view mode (or zoom) changes. `useLayoutEffect` runs synchronously
  // after React commits DOM mutations but BEFORE the browser paints, so the
  // new column widths and the adjusted scrollLeft land in the same paint
  // frame — no visible two-step lag.
  const scrollToToday = useCallback(() => {
    const scrollEl = document.querySelector('.gantt-scroll') as HTMLElement | null;
    const todayEl = scrollEl?.querySelector(
      '[data-roadmap-ui="gantt-today"]',
    ) as HTMLElement | null;
    if (!scrollEl || !todayEl) return;
    const containerRect = scrollEl.getBoundingClientRect();
    const todayRect = todayEl.getBoundingClientRect();
    const sidebar = parseFloat(
      getComputedStyle(scrollEl).getPropertyValue('--gantt-sidebar-width') || '0',
    );
    const targetX = containerRect.left + sidebar + (containerRect.width - sidebar) * 0.2;
    const delta = todayRect.left - targetX;
    if (Math.abs(delta) < 1) return;
    scrollEl.scrollLeft = Math.max(0, scrollEl.scrollLeft + delta);
  }, []);

  // Snap today to the 20% mark whenever view mode / zoom changes.
  useLayoutEffect(() => {
    scrollToToday();
  }, [viewMode, zoomLevel, scrollToToday]);

  // Track whether the today indicator is currently visible in the timeline
  // area (right of the sidebar). Listen to scroll and window resize so the
  // "Today" button in the toolbar shows/hides accordingly. We poll for the
  // gantt-scroll element on mount because it isn't in the DOM during the
  // loading state — without this the listener would never attach.
  const [todayVisible, setTodayVisible] = useState(true);
  useEffect(() => {
    let scrollEl: HTMLElement | null = null;
    let attachRaf = 0;

    const check = () => {
      if (!scrollEl) return;
      const todayEl = scrollEl.querySelector(
        '[data-roadmap-ui="gantt-today"]',
      ) as HTMLElement | null;
      if (!todayEl) return;
      const containerRect = scrollEl.getBoundingClientRect();
      const todayRect = todayEl.getBoundingClientRect();
      const sidebar = parseFloat(
        getComputedStyle(scrollEl).getPropertyValue('--gantt-sidebar-width') || '0',
      );
      const visibleLeft = containerRect.left + sidebar;
      const visibleRight = containerRect.right;
      setTodayVisible(todayRect.left >= visibleLeft && todayRect.left <= visibleRight);
    };

    const tryAttach = () => {
      scrollEl = document.querySelector('.gantt-scroll') as HTMLElement | null;
      if (!scrollEl) {
        attachRaf = requestAnimationFrame(tryAttach);
        return;
      }
      check();
      scrollEl.addEventListener('scroll', check, { passive: true });
      window.addEventListener('resize', check);
    };
    tryAttach();

    return () => {
      cancelAnimationFrame(attachRaf);
      scrollEl?.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [viewMode, zoomLevel, isLoading]);

  // Filter and search state
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Add task dialog state
  const [addTaskDialogOpen, setAddTaskDialogOpen] = useState(false);
  const [addTaskParentId, setAddTaskParentId] = useState<string | undefined>(undefined);
  const [editingCrmTask, setEditingCrmTask] = useState<CrmTask | null>(null);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [projectMembers, setProjectMembers] = useState<{ userId: string; user?: { id: string; name: string; email: string; avatar?: string } }[]>([]);
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
    toast.error(t.projects.gantt.labelCreateFailed);
    return null;
  }, [projectId]);

  // Map view mode → gantt range. Weekly now has its own range in the gantt
  // library (1 column = 1 week); see VIEW_BASELINE_ZOOM above.
  const range: 'daily' | 'weekly' | 'monthly' | 'quarterly' = viewMode;
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter configurations for gantt tasks
  const filterConfigs: FilterConfig[] = useMemo(() => {
    // Get unique owners from features
    const owners = features
      .filter(f => f.owner?.name)
      .reduce((acc, f) => {
        if (f.owner && !acc.find(o => o.value === f.owner!.id)) {
          acc.push({ value: f.owner.id, label: f.owner.name });
        }
        return acc;
      }, [] as { value: string; label: string }[]);

    // Get unique priorities
    const priorities = [...new Set(features.map(f => f.priority).filter(Boolean))]
      .map(p => ({ value: p!, label: capitalize(p!) }));

    return [
      {
        field: 'status',
        label: t.projects.gantt.filterStatus,
        options: statuses.map(s => ({ value: s.id, label: s.name })),
      },
      {
        field: 'assignee',
        label: t.projects.gantt.filterAssignee,
        options: owners,
      },
      {
        field: 'priority',
        label: t.projects.gantt.filterPriority,
        options: priorities.length > 0 ? priorities : [
          { value: 'low', label: t.projects.gantt.priorityLow },
          { value: 'medium', label: t.projects.gantt.priorityMedium },
          { value: 'high', label: t.projects.gantt.priorityHigh },
          { value: 'urgent', label: t.projects.gantt.priorityUrgent },
        ],
      },
    ];
  }, [features, t]);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  // Fetch data on mount
  const loadData = useCallback(async () => {
    if (!projectId) return;

    setIsLoading(true);
    setError(null);

    try {
      const [tasksResult, milestonesResult] = await Promise.all([
        ganttApi.getTasks(projectId),
        ganttApi.getMilestones(projectId),
      ]);

      if (tasksResult.success && tasksResult.data) {
        const mappedFeatures = organizeTasksWithSubtasks(tasksResult.data);
        setFeatures(mappedFeatures);
      } else {
        console.error('Failed to load tasks:', tasksResult.error);
      }

      if (milestonesResult.success && milestonesResult.data) {
        const mappedMarkers = milestonesResult.data.map(mapMilestoneToMarker);
        setMarkers(mappedMarkers);
      } else {
        console.error('Failed to load milestones:', milestonesResult.error);
      }
    } catch (err) {
      console.error('Error loading Gantt data:', err);
      setError(t.projects.gantt.failedToLoadData);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Fetch project members for assignee dropdown
  useEffect(() => {
    async function loadMembers() {
      if (!projectId) return;
      const result = await membersApi.list(projectId);
      if (result.success && result.data) {
        setProjectMembers(result.data);
      }
    }
    loadMembers();
  }, [projectId]);

  const handleViewFeature = (id: string) => {
    const feature = features.find((f) => f.id === id);
    if (feature) {
      setSelectedFeature(feature);
      setViewSheetOpen(true);
    }
  };

  const handleRenameFeature = (id: string) => {
    const feature = features.find((f) => f.id === id);
    if (feature) {
      setSelectedFeature(feature);
      setNewName(feature.name);
      setRenameDialogOpen(true);
    }
  };

  const handleSaveRename = async () => {
    if (selectedFeature && newName.trim()) {
      // Update local state optimistically
      setFeatures((prev) =>
        prev.map((feature) =>
          feature.id === selectedFeature.id ? { ...feature, name: newName.trim() } : feature
        )
      );
      setRenameDialogOpen(false);
      setSelectedFeature(null);
      setNewName('');

      // Note: Could add API call here to persist the name change
      toast.success(t.projects.gantt.taskRenamed);
    }
  };

  const handleUpdateFeatureStatus = async (statusId: string) => {
    if (selectedFeature) {
      const newStatus = statuses.find((s) => s.id === statusId);
      if (newStatus) {
        // Update local state optimistically
        setFeatures((prev) =>
          prev.map((feature) =>
            feature.id === selectedFeature.id
              ? {
                  ...feature,
                  status: newStatus,
                  group: { id: statusId, name: newStatus.name },
                }
              : feature
          )
        );
        setSelectedFeature({ ...selectedFeature, status: newStatus, group: { id: statusId, name: newStatus.name } });

        // Persist to API
        const result = await ganttApi.updateTaskStatus(selectedFeature.id, statusId);
        if (!result.success) {
          toast.error(t.projects.gantt.statusUpdateFailed);
          loadData(); // Reload to get correct state
        }
      }
    }
  };

  const handleCopyLink = (id: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/projects/task/${id}`);
    toast.success(t.projects.gantt.linkCopied);
  };

  const handleRemoveFeature = async (id: string) => {
    // Update local state optimistically
    setFeatures((prev) => prev.filter((feature) => feature.id !== id));

    // Delete from API
    const result = await ganttApi.deleteTask(projectId, id);
    if (result.success) {
      toast.success(t.projects.gantt.taskDeleted);
    } else {
      toast.error(t.projects.gantt.taskDeleteFailed);
      loadData(); // Reload to restore
    }
  };

  const handleRemoveMarker = async (id: string) => {
    const marker = markers.find((m) => m.id === id);
    if (!marker) return;

    // Update local state optimistically
    setMarkers((prev) => prev.filter((m) => m.id !== id));

    // Delete from API
    const result = await ganttApi.deleteMilestone(projectId, id);
    if (result.success) {
      toast.success(t.projects.gantt.milestoneDeleted);
    } else {
      toast.error(t.projects.gantt.milestoneDeleteFailed);
      loadData(); // Reload to restore
    }
  };

  const handleViewMarker = (id: string, event?: React.MouseEvent) => {
    const marker = markers.find((m) => m.id === id);
    if (marker) {
      setSelectedMarker(marker);
      if (event) {
        setMarkerPopoverPosition({ x: event.clientX, y: event.clientY });
      }
      setViewMarkerPopoverOpen(true);
    }
  };

  const handleRenameMarker = (id: string) => {
    const marker = markers.find((m) => m.id === id);
    if (marker) {
      setSelectedMarker(marker);
      setNewName(marker.label);
      setRenameMarkerDialogOpen(true);
    }
  };

  const handleSaveMarkerRename = async () => {
    if (selectedMarker && newName.trim()) {
      // Update local state
      setMarkers((prev) =>
        prev.map((marker) =>
          marker.id === selectedMarker.id ? { ...marker, label: newName.trim() } : marker
        )
      );
      setRenameMarkerDialogOpen(false);

      // Persist to API
      const result = await ganttApi.updateMilestone(projectId, selectedMarker.id, { name: newName.trim() });
      if (result.success) {
        toast.success(t.projects.gantt.milestoneRenamed);
      } else {
        toast.error(t.projects.gantt.milestoneRenameFailed);
      }

      setSelectedMarker(null);
      setNewName('');
    }
  };

  const handleChangeMarkerDate = async (markerId: string, newDate: Date) => {
    setMarkers((prev) =>
      prev.map((marker) =>
        marker.id === markerId ? { ...marker, date: newDate } : marker
      )
    );
    setSelectedMarker((prev) =>
      prev?.id === markerId ? { ...prev, date: newDate } : prev
    );

    const result = await ganttApi.updateMilestone(projectId, markerId, { dueDate: newDate.toISOString() });
    if (result.success) {
      toast.success(t.projects.gantt.milestoneDateUpdated);
    } else {
      toast.error(t.projects.gantt.milestoneDateUpdateFailed);
      loadData();
    }
  };

  const handleChangeMarkerColor = (markerId: string, colorClassName: string) => {
    setMarkers((prev) =>
      prev.map((marker) =>
        marker.id === markerId ? { ...marker, className: colorClassName } : marker
      )
    );
    // Update selectedMarker to reflect the change in UI
    setSelectedMarker((prev) =>
      prev?.id === markerId ? { ...prev, className: colorClassName } : prev
    );
  };

  const handleCreateMarker = async (date: Date) => {
    const tempId = `temp-${Date.now()}`;
    const newMarker: GanttMarkerType = {
      id: tempId,
      date,
      label: 'New Milestone',
      className: 'bg-purple-100 text-purple-900',
    };

    // Add optimistically
    setMarkers((prev) => [...prev, newMarker]);

    // Create in API
    const result = await ganttApi.createMilestone(projectId, {
      name: 'New Milestone',
      dueDate: date.toISOString(),
    });

    if (result.success && result.data) {
      // Replace temp with real milestone
      setMarkers((prev) =>
        prev.map((m) => (m.id === tempId ? mapMilestoneToMarker(result.data) : m))
      );
      toast.success(t.projects.gantt.milestoneCreated);
    } else {
      // Remove temp on failure
      setMarkers((prev) => prev.filter((m) => m.id !== tempId));
      toast.error(t.projects.gantt.milestoneCreateFailed);
    }
  };

  const handleMoveFeature = async (id: string, startAt: Date, endAt: Date | null) => {
    if (!endAt || !canWrite) return;

    // Update local state optimistically
    setFeatures((prev) =>
      prev.map((feature) =>
        feature.id === id ? { ...feature, startAt, endAt } : feature
      )
    );

    // Persist to API
    const result = await ganttApi.updateTaskDates(
      projectId,
      id,
      startAt.toISOString(),
      endAt.toISOString()
    );

    if (result.success) {
      toast.success(t.projects.gantt.taskDatesUpdated);
    } else {
      toast.error(t.projects.gantt.taskDateUpdateFailed);
      loadData(); // Reload to get correct state
    }
  };

  const handleAddFeature = (_date?: Date) => {
    setAddTaskParentId(undefined);
    setAddTaskDialogOpen(true);
  };

  const handleTaskCreated = (task: any) => {
    const newFeature = mapTaskToFeature(task, !!task.parentTaskId);

    if (task.parentTaskId) {
      // Insert subtask right after its parent
      setFeatures((prev) => {
        const parentIndex = prev.findIndex((f) => f.id === task.parentTaskId);
        if (parentIndex === -1) return [...prev, newFeature];

        // Find the last subtask of this parent
        let insertIndex = parentIndex + 1;
        while (insertIndex < prev.length && prev[insertIndex].parentTaskId === task.parentTaskId) {
          insertIndex++;
        }

        const updated = [...prev];
        updated.splice(insertIndex, 0, newFeature);
        return updated;
      });
    } else {
      setFeatures((prev) => [...prev, newFeature]);
    }
  };

  const handleAddMilestone = async (featureId: string) => {
    const feature = features.find((f) => f.id === featureId);
    if (!feature) {
      toast.error(t.projects.gantt.taskNotFound);
      return;
    }

    const tempId = `temp-${Date.now()}`;
    const newMarker: GanttMarkerType = {
      id: tempId,
      date: feature.endAt,
      label: `${feature.name} - Milestone`,
      className: 'bg-purple-100 text-purple-900',
    };

    // Add optimistically
    setMarkers((prev) => [...prev, newMarker]);

    // Create in API
    const result = await ganttApi.createMilestone(projectId, {
      name: `${feature.name} - Milestone`,
      dueDate: feature.endAt.toISOString(),
    });

    if (result.success && result.data) {
      // Replace temp with real milestone
      setMarkers((prev) =>
        prev.map((m) => (m.id === tempId ? mapMilestoneToMarker(result.data) : m))
      );
      toast.success(t.projects.gantt.milestoneAdded);
    } else {
      // Remove temp on failure
      setMarkers((prev) => prev.filter((m) => m.id !== tempId));
      toast.error(t.projects.gantt.milestoneAddFailed);
    }
  };

  const handleAddSubtask = (parentId: string) => {
    const parentFeature = features.find((f) => f.id === parentId);
    if (!parentFeature) {
      toast.error(t.projects.gantt.parentTaskNotFound);
      return;
    }

    setAddTaskParentId(parentId);
    setAddTaskDialogOpen(true);
  };

  const handleTaskDialogSave = async (data: {
    title: string;
    description?: string;
    status: string;
    priority?: 'low' | 'medium' | 'high';
    dueDate?: Date;
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

    setIsCreatingTask(true);
    const result = await tasksApi.create(projectId, {
      title: data.title,
      description: data.description,
      status: statusMap[data.status] || 'todo',
      priority: data.priority,
      dueDate: data.dueDate?.toISOString(),
      parentTaskId: addTaskParentId,
      repeat: data.repeat ? { frequency: data.repeat.frequency } : undefined,
    });

    setIsCreatingTask(false);

    if (result.success && result.data) {
      handleTaskCreated(result.data);
      setAddTaskDialogOpen(false);
      toast.success(t.projects.gantt.taskCreated);
    } else {
      toast.error(t.projects.gantt.taskCreateFailed);
    }
  };

  // Map Gantt feature to CRM Task format for the detail panel
  const featureToCrmTask = (feature: GanttFeature): CrmTask => {
    // Map project status to CRM status (now 1:1)
    const statusMap: Record<string, CrmTask['status']> = {
      'backlog': 'backlog',
      'todo': 'todo',
      'in_progress': 'in_progress',
      'in_review': 'in_review',
      'testing': 'testing',
      'done': 'done',
      'cancelled': 'cancelled',
    };

    return {
      id: feature.id,
      title: feature.name,
      description: feature.originalTask?.description,
      status: statusMap[feature.status.id] || 'todo',
      priority: (feature.priority as CrmTask['priority']) || undefined,
      assignee: feature.owner ? { id: feature.owner.id, name: feature.owner.name, avatar: feature.owner.image } : undefined,
      dueDate: feature.endAt,
      createdAt: feature.originalTask?.createdAt ? new Date(feature.originalTask.createdAt) : new Date(),
      labels: feature.labels,
    };
  };

  // Apply filters and search to features
  const filteredFeatures = useMemo(() => {
    let result = features;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(feature => feature.name.toLowerCase().includes(q));
    }

    if (activeFilters.length > 0) {
      result = result.filter(feature => {
        return activeFilters.every(filter => {
          if (!filter.value) return true;

          switch (filter.field) {
            case 'status': {
              const match = feature.status.id === filter.value;
              return filter.operator === 'is not' ? !match : match;
            }
            case 'assignee': {
              const match = feature.owner?.id === filter.value;
              return filter.operator === 'is not' ? !match : match;
            }
            case 'priority': {
              const match = feature.priority === filter.value;
              return filter.operator === 'is not' ? !match : match;
            }
            default:
              return true;
          }
        });
      });
    }

    return result;
  }, [features, activeFilters, searchQuery]);

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <p className="text-destructive">{error}</p>
          <Button onClick={loadData}>{t.projects.gantt.retry}</Button>
        </div>
      </div>
    );
  }

  const hasFeatures = filteredFeatures.length > 0;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 pt-[10px] pb-[10px] border-b bg-background">
        <div className="flex items-center gap-2">
          {/* Filter Pills */}
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />

          {/* View Mode Select */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-[100px] justify-between shadow-none text-sm text-muted-foreground">
                {{ daily: t.projects.gantt.viewDay, weekly: t.projects.gantt.viewWeek, monthly: t.projects.gantt.viewMonth, quarterly: t.projects.gantt.viewQuarter }[viewMode]}
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[100px] p-1">
              {([['daily', t.projects.gantt.viewDay], ['weekly', t.projects.gantt.viewWeek], ['monthly', t.projects.gantt.viewMonth], ['quarterly', t.projects.gantt.viewQuarter]] as [typeof viewMode, string][]).map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  onClick={() => handleViewModeChange(value)}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded h-auto"
                >
                  <span>{label}</span>
                  {viewMode === value && <Check className="h-3.5 w-3.5" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Today jump button — only visible when the today line is off-screen. */}
          {!todayVisible && (
            <Button
              variant="outline"
              size="sm"
              onClick={scrollToToday}
              className="h-8 shadow-none text-sm text-muted-foreground"
            >
              {t.projects.gantt.today}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setZoomLevel((z) => Math.max(50, z - 25))}
            disabled={zoomLevel <= 50}
          >
            <MinusIcon className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground w-12 text-center">{zoomLevel}%</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setZoomLevel((z) => Math.min(200, z + 25))}
            disabled={zoomLevel >= 200}
          >
            <PlusIcon className="h-4 w-4" />
          </Button>
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
                  placeholder={t.projects.gantt.searchTasks}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>
          {canWrite && (
            <Button
              size="sm"
              className="h-8"
              onClick={() => handleAddFeature()}
            >
              <PlusIcon className="h-4 w-4 mr-1" />
              {t.projects.gantt.addTask}
            </Button>
          )}
        </div>
      </div>

      <GanttProvider
        className={cn("border-b flex-1 min-h-0", !viewSheetOpen && "border-r")}
        // Hover-to-add (dashed border + plus icon) removed; the canvas now
        // pans horizontally on click+drag instead. New tasks are still added
        // from the sidebar's + button.
        range={range}
        zoom={effectiveZoom}
      >
      <GanttSidebar onAddTask={canWrite ? () => handleAddFeature() : undefined}>
        {hasFeatures ? (
          <div>
            {filteredFeatures.map((feature) => (
              <SidebarItemWithContextMenu
                key={feature.id}
                feature={feature}
                onView={handleViewFeature}
                onRename={handleRenameFeature}
                onCopyLink={handleCopyLink}
                onRemove={handleRemoveFeature}
                onAddSubtask={canWrite ? handleAddSubtask : () => {}}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-4 text-center h-32">
            <p className="text-xs text-muted-foreground">{t.projects.gantt.noTasksWithDates}</p>
          </div>
        )}
      </GanttSidebar>
      <GanttTimeline>
        <GanttHeader />
        <GanttFeatureList>
          {hasFeatures && (
            <GanttTreeView
              features={filteredFeatures}
              renderFeature={(f) => {
                const feature = f as GanttFeature;
                return (
                <div className="flex" key={feature.id}>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <Button
                        onClick={() => handleViewFeature(feature.id)}
                        type="button"
                        variant="ghost"
                        className="p-0 h-auto w-auto"
                      >
                        <GanttFeatureItem
                          onMove={handleMoveFeature}
                          {...feature}
                        >
                          <p className="flex-1 truncate text-xs">
                            {feature.name}
                          </p>
                          {feature.owner && (
                            <Avatar className="h-4 w-4">
                              <AvatarImage src={feature.owner.image} />
                              <AvatarFallback>
                                {feature.owner.name?.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                          )}
                        </GanttFeatureItem>
                      </Button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        className="flex items-center gap-2"
                        onClick={() => handleViewFeature(feature.id)}
                      >
                        <EyeIcon className="text-muted-foreground" size={16} />
                        {t.projects.gantt.viewTask}
                      </ContextMenuItem>
                      <ContextMenuItem
                        className="flex items-center gap-2"
                        onClick={() => handleRenameFeature(feature.id)}
                      >
                        <PencilIcon className="text-muted-foreground" size={16} />
                        {t.projects.gantt.rename}
                      </ContextMenuItem>
                      <ContextMenuItem
                        className="flex items-center gap-2"
                        onClick={() => handleCopyLink(feature.id)}
                      >
                        <LinkIcon className="text-muted-foreground" size={16} />
                        {t.projects.gantt.copyLink}
                      </ContextMenuItem>
                      {!feature.isSubtask && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            className="flex items-center gap-2"
                            onClick={() => handleAddSubtask(feature.id)}
                          >
                            <PlusIcon className="text-muted-foreground" size={16} />
                            {t.projects.gantt.addSubtask}
                          </ContextMenuItem>
                        </>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className="flex items-center gap-2"
                        onSelect={() => handleAddMilestone(feature.id)}
                      >
                        <Milestone className="text-purple-600" size={16} />
                        {t.projects.gantt.addMilestone}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className="flex items-center gap-2 text-destructive"
                        onClick={() => handleRemoveFeature(feature.id)}
                      >
                        <TrashIcon size={16} className="text-destructive" />
                        {t.projects.gantt.removeFromRoadmap}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              );
              }}
            />
          )}
        </GanttFeatureList>
        {markers.map((marker) => (
          <GanttMarker
            key={marker.id}
            {...marker}
            onRemove={handleRemoveMarker}
            onRename={handleRenameMarker}
            onSelect={handleViewMarker}
          />
        ))}
        <GanttToday />
      </GanttTimeline>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.gantt.renameTask}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">{t.projects.gantt.nameLabel}</Label>
              <Input
                id="name"
                ref={inputRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveRename();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              {t.projects.gantt.cancel}
            </Button>
            <Button onClick={handleSaveRename}>{t.projects.gantt.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feature detail panel is now rendered globally via ObjectPanelHost. */}

      {/* Rename Marker Dialog */}
      <Dialog open={renameMarkerDialogOpen} onOpenChange={setRenameMarkerDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.gantt.renameMilestone}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="marker-name">{t.projects.gantt.nameLabel}</Label>
              <Input
                id="marker-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveMarkerRename();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameMarkerDialogOpen(false)}>
              {t.projects.gantt.cancel}
            </Button>
            <Button onClick={handleSaveMarkerRename}>{t.projects.gantt.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Marker Popover */}
      <Popover open={viewMarkerPopoverOpen} onOpenChange={(open) => {
        if (!open) {
          setViewMarkerPopoverOpen(false);
          setSelectedMarker(null);
          setMarkerPopoverPosition(null);
          setMarkerDatePickerOpen(false);
        }
      }}>
        <PopoverTrigger asChild>
          <div
            className="fixed pointer-events-none"
            style={{
              left: markerPopoverPosition?.x ?? 0,
              top: markerPopoverPosition?.y ?? 0,
              width: 1,
              height: 1,
            }}
          />
        </PopoverTrigger>
        <PopoverContent className={cn("p-1", markerDatePickerOpen ? "w-auto" : "w-52")} align="start" sideOffset={5}>
          {selectedMarker && (
            <>
              {markerDatePickerOpen ? (
                <div>
                  <div className="px-2 py-1.5 flex items-center gap-2">
                    <Button
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground transition-colors p-0 h-auto w-auto"
                      onClick={() => setMarkerDatePickerOpen(false)}
                    >
                      <ChevronDown className="h-4 w-4 rotate-90" />
                    </Button>
                    <p className="text-sm font-medium">{t.projects.gantt.changeDateAndTime}</p>
                  </div>
                  <Separator className="my-1" />
                  <CalendarPicker
                    mode="single"
                    selected={selectedMarker.date}
                    onSelect={(date) => {
                      if (date) {
                        const prev = selectedMarker.date;
                        date.setHours(prev.getHours(), prev.getMinutes());
                        handleChangeMarkerDate(selectedMarker.id, date);
                      }
                    }}
                    initialFocus
                  />
                  <Separator />
                  <div className="px-3 py-2 flex items-center justify-center gap-1.5">
                    <Select
                      value={selectedMarker.date.getHours().toString().padStart(2, '0')}
                      onValueChange={(h) => {
                        const newDate = new Date(selectedMarker.date);
                        newDate.setHours(parseInt(h));
                        handleChangeMarkerDate(selectedMarker.id, newDate);
                      }}
                    >
                      <SelectTrigger className="w-24 h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0')).map((h) => (
                          <SelectItem key={h} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-sm text-muted-foreground font-medium">:</span>
                    <Select
                      value={selectedMarker.date.getMinutes().toString().padStart(2, '0')}
                      onValueChange={(m) => {
                        const newDate = new Date(selectedMarker.date);
                        newDate.setMinutes(parseInt(m));
                        handleChangeMarkerDate(selectedMarker.id, newDate);
                      }}
                    >
                      <SelectTrigger className="w-24 h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, '0')).map((m) => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : (
                <>
                  {/* Title & date header */}
                  <div className="px-2 py-1.5">
                    <p className="text-sm font-medium leading-none truncate">{selectedMarker.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {selectedMarker.date.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric'
                      })}
                      {(selectedMarker.date.getHours() !== 0 || selectedMarker.date.getMinutes() !== 0) && (
                        <span> at {selectedMarker.date.getHours().toString().padStart(2, '0')}:{selectedMarker.date.getMinutes().toString().padStart(2, '0')}</span>
                      )}
                    </p>
                  </div>

                  <Separator className="my-1" />

                  {/* Color swatches */}
                  <div className="px-2 py-1.5">
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">{t.projects.gantt.colorLabel}</p>
                    <div className="grid grid-cols-8 gap-1">
                      {markerColors.map((colorOption) => (
                        <Button
                          key={colorOption.name}
                          variant="ghost"
                          className={cn(
                            "h-5 w-5 rounded-[4px] flex items-center justify-center transition-shadow p-0",
                            selectedMarker.className === colorOption.className
                              ? 'ring-2 ring-ring ring-offset-1 ring-offset-background'
                              : 'hover:ring-1 hover:ring-ring/40 hover:ring-offset-1 hover:ring-offset-background'
                          )}
                          style={{ backgroundColor: colorOption.color }}
                          onClick={() => handleChangeMarkerColor(selectedMarker.id, colorOption.className)}
                          title={colorOption.name}
                        >
                          {selectedMarker.className === colorOption.className && (
                            <Check className="h-3 w-3 text-foreground/60" />
                          )}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <Separator className="my-1" />

                  {/* Menu items */}
                  <div
                    role="menuitem"
                    className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
                    onClick={() => setMarkerDatePickerOpen(true)}
                  >
                    <CalendarIcon className="h-4 w-4" />
                    {t.projects.gantt.changeDate}
                  </div>
                  <div
                    role="menuitem"
                    className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
                    onClick={() => {
                      setViewMarkerPopoverOpen(false);
                      setMarkerPopoverPosition(null);
                      handleRenameMarker(selectedMarker.id);
                    }}
                  >
                    <SquarePen className="h-4 w-4" />
                    {t.projects.gantt.rename}
                  </div>
                  <div
                    role="menuitem"
                    className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors"
                    onClick={() => {
                      handleRemoveMarker(selectedMarker.id);
                      setViewMarkerPopoverOpen(false);
                      setSelectedMarker(null);
                      setMarkerPopoverPosition(null);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t.projects.gantt.delete}
                  </div>
                </>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>

      {/* Add/Edit Task Dialog */}
      <TaskDialog
        open={addTaskDialogOpen}
        onOpenChange={(open) => {
          setAddTaskDialogOpen(open);
          if (!open) setEditingCrmTask(null);
        }}
        editingTask={editingCrmTask}
        availableAssignees={projectMembers
          .filter((m) => m.user?.name)
          .map((m) => ({ id: m.userId, name: m.user!.name, avatar: m.user?.avatar }))}
        availableCompanies={[]}
        availableLabels={availableLabels}
        onCreateLabel={handleCreateLabel}
        hideRecord
        onSave={handleTaskDialogSave}
        onUpdate={(taskId, data) => {
          const updateData: Record<string, any> = {};
          if (data.title) updateData.title = data.title;
          if (data.description !== undefined) updateData.description = data.description;
          if (data.status) {
            const statusMap: Record<string, string> = { 'backlog': 'backlog', 'todo': 'todo', 'in_progress': 'in_progress', 'in_review': 'in_review', 'testing': 'testing', 'done': 'done', 'cancelled': 'cancelled' };
            updateData.status = statusMap[data.status] || data.status;
          }
          if (data.priority) updateData.priority = data.priority;
          if (data.dueDate !== undefined) updateData.dueDate = data.dueDate?.toISOString();
          if (data.labels !== undefined) updateData.labels = data.labels;

          (async () => {
            const result = await tasksApi.update(projectId, taskId, updateData);
            if (result.success) {
              loadData();
              setAddTaskDialogOpen(false);
              setEditingCrmTask(null);
              toast.success(t.projects.gantt.taskUpdated);
            } else {
              toast.error(t.projects.gantt.taskUpdateFailed);
            }
          })();
        }}
        isPending={isCreatingTask}
      />
    </GanttProvider>
    </div>
  );
};

export default function Page() {
  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <GanttPage />
    </div>
  );
}
