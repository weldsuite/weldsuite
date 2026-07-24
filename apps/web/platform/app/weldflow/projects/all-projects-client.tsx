
import React, { useState, useEffect, useCallback, useMemo, useTransition } from "react";
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { useRouter } from '@/lib/router/use-router';
import {
  Trash2,
  FolderKanban,
  EllipsisVertical,
  Pencil,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Pause,
  X,
  Check,
} from "lucide-react";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Label } from "@weldsuite/ui/components/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@weldsuite/ui/components/popover";
import { Calendar } from "@weldsuite/ui/components/calendar";
import { Avatar, AvatarFallback, AvatarImage } from "@weldsuite/ui/components/avatar";
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@weldsuite/ui/components/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type ActiveFilter, type SortState } from '@/components/entity-list';
import { coloredSquareColors, coloredSquareIcons } from "@/components/app-sidebar-layout";
import type { LucideIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { projectsApi, membersApi, type ApiProject } from "@/app/weldflow/lib/api-client";
import { projectKeys } from "@/hooks/queries/use-projects-queries";
import { useTopic } from "@weldsuite/realtime/react";
import { TeamMemberDetailsPanel, type TeamMemberDetail } from "@/components/team-member-details-panel";

type TableStatus = "on-track" | "at-risk" | "off-track" | "on-hold" | "completed";

interface Project {
  id: string;
  name: string;
  status: TableStatus;
  progress: number;
  owner: {
    name: string;
    initials: string;
    userId?: string;
    email?: string;
    avatar?: string;
    role?: string;
    joinedAt?: string;
  };
  dueDate: string;
  priority: string;
  updatedAt: Date;
  color?: string;
  icon?: string;
}

function mapApiStatusToTableStatus(apiStatus: string): TableStatus {
  const statusMap: Record<string, TableStatus> = {
    'planning': 'on-track',
    'active': 'on-track',
    'on_hold': 'on-hold',
    'on-hold': 'on-hold',
    'completed': 'completed',
    'cancelled': 'off-track',
    'archived': 'completed'
  };
  return statusMap[apiStatus] || 'on-track';
}

function mapHealthToTableStatus(health: string): TableStatus {
  const healthMap: Record<string, TableStatus> = {
    'on_track': 'on-track',
    'at_risk': 'at-risk',
    'off_track': 'off-track',
    'critical': 'off-track',
  };
  return healthMap[health] || 'on-track';
}

function getInitials(name: string): string {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

// Status and priority configs are now built inside the component using i18n
// (moved below the component definition start)

interface AllProjectsClientProps {
  initialProjects: ApiProject[];
  error?: string | null;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  // Controlled-mode (server-side filtering / search / sort).
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  activeFilters?: ActiveFilter[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;
  sortState?: SortState | null;
  onSortChange?: (state: SortState | null) => void;
}

export function AllProjectsClient({
  initialProjects,
  error,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  searchQuery: searchQueryProp,
  onSearchChange,
  activeFilters: activeFiltersProp,
  onFiltersChange,
  sortState: sortStateProp,
  onSortChange,
}: AllProjectsClientProps) {
  const t = getTranslations('projects');

  const statusConfig: Record<TableStatus, { label: string; color: string; bg: string; icon: React.ElementType }> = useMemo(() => ({
    'on-track': { label: t.allProjects.statusOnTrack, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950', icon: CheckCircle2 },
    'at-risk': { label: t.allProjects.statusAtRisk, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950', icon: AlertCircle },
    'off-track': { label: t.allProjects.statusOffTrack, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950', icon: XCircle },
    'on-hold': { label: t.allProjects.statusOnHold, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary', icon: Pause },
    'completed': { label: t.allProjects.statusCompleted, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary', icon: CheckCircle2 },
  }), [t]);

  const priorityConfig: Record<string, { label: string; color: string; bg: string }> = useMemo(() => ({
    'critical': { label: t.allProjects.priorityCritical, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
    'high': { label: t.allProjects.priorityHigh, color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
    'medium': { label: t.allProjects.priorityMedium, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    'low': { label: t.allProjects.priorityLow, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  }), [t]);

  useBreadcrumbs([
    { label: t.allProjects.breadcrumbProjects, href: '/weldflow' },
    { label: t.allProjects.breadcrumbAllProjects },
  ]);

  const [projects, setProjects] = useState<Project[]>([]);
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
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectPriority, setNewProjectPriority] = useState("medium");
  const [selectedColor, setSelectedColor] = useState(coloredSquareColors[0].value);
  const [selectedIcon, setSelectedIcon] = useState<LucideIcon>(coloredSquareIcons[0].value);
  const [colorPopoverOpen, setColorPopoverOpen] = useState(false);
  const [iconPopoverOpen, setIconPopoverOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [selectedMember, setSelectedMember] = useState<TeamMemberDetail | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  // Transform initial projects
  useEffect(() => {
    if (initialProjects && initialProjects.length > 0) {
      const transformedProjects: Project[] = initialProjects.map((project) => ({
        id: project.id,
        name: project.name,
        status: (project.derivedStatus as TableStatus | undefined) ?? (project.health ? mapHealthToTableStatus(project.health) : mapApiStatusToTableStatus(project.status)),
        progress: project.derivedProgress ?? project.progress ?? 0,
        owner: {
          name: t.allProjects.unassigned,
          initials: "U",
        },
        dueDate: project.endDate ? new Date(project.endDate).toISOString().split('T')[0] : "",
        priority: project.priority || "medium",
        updatedAt: new Date(project.updatedAt),
        color: project.color || undefined,
        icon: project.icon || undefined,
      }));
      setProjects(transformedProjects);

      // Fetch members for each project to find the owner
      Promise.all(
        initialProjects.map(async (project) => {
          const result = await membersApi.list(project.id);
          if (result.success && result.data) {
            const owner = result.data.find((m) => m.role === 'owner');
            if (owner?.user?.name) {
              return {
                projectId: project.id,
                name: owner.user.name,
                userId: owner.userId,
                email: owner.user.email,
                avatar: owner.user.avatar,
                role: owner.role,
                joinedAt: owner.joinedAt,
              };
            }
          }
          return null;
        })
      ).then((owners) => {
        const ownerMap = new Map<string, string>();
        owners.forEach((o) => {
          if (o) ownerMap.set(o.projectId, o.name);
        });
        if (ownerMap.size > 0) {
          setProjects((prev) =>
            prev.map((p) => {
              const ownerName = ownerMap.get(p.id);
              if (ownerName) {
                const ownerData = owners.find(o => o?.projectId === p.id);
                return {
                  ...p,
                  owner: {
                    name: ownerName,
                    initials: getInitials(ownerName),
                    userId: ownerData?.userId,
                    email: ownerData?.email,
                    avatar: ownerData?.avatar,
                    role: ownerData?.role,
                    joinedAt: ownerData?.joinedAt,
                  },
                };
              }
              return p;
            })
          );
        }
      });
    }
  }, [initialProjects, t.allProjects.unassigned]);

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  // Real-time: invalidate project queries on any project or member event
  const queryClient = useQueryClient();
  const invalidateProjects = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: projectKeys.all });
  }, [queryClient]);

  useTopic('project', invalidateProjects);
  useTopic('project_member', invalidateProjects);

  // Add project
  const handleAddProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      setLoading(true);
      const iconLabel = coloredSquareIcons.find((i) => i.value === selectedIcon)?.label || '';
      const result = await projectsApi.create({ name: newProjectName, status: "Planning", priority: newProjectPriority, color: selectedColor, icon: iconLabel });
      if (!result.success || !result.data) throw new Error(result.error || 'Failed to create project');
      const newProject = result.data;
      const transformedProject: Project = {
        id: newProject.id,
        name: newProject.name,
        status: mapApiStatusToTableStatus(newProject.status || 'planning'),
        progress: newProject.progress || 0,
        owner: { name: newProject.clientName || t.allProjects.unassigned, initials: getInitials(newProject.clientName || t.allProjects.unassigned) },
        dueDate: newProject.endDate ? new Date(newProject.endDate).toISOString().split('T')[0] : "",
        priority: newProject.priority || "medium",
        updatedAt: new Date(newProject.updatedAt || new Date()),
      };
      setProjects([transformedProject, ...projects]);
      setShowAddDialog(false);
      setNewProjectName("");
      setNewProjectPriority("medium");
      setSelectedColor(coloredSquareColors[0].value);
      setSelectedIcon(coloredSquareIcons[0].value);
      toast.success(t.allProjects.projectCreated);
    } catch (error) {
      console.error('Failed to create project:', error);
      toast.error(t.allProjects.projectCreateFailed);
    } finally {
      setLoading(false);
    }
  };

  // Inline edit: optimistically patch the row, then persist via projectsApi.update.
  // On failure we roll back. Matches the updateTaskInline pattern on the tasks page.
  const updateProjectInline = useCallback(async (
    projectId: string,
    patch: Partial<Pick<Project, 'priority' | 'dueDate'>>,
    apiPayload: { priority?: string; endDate?: string },
  ) => {
    const prevSnapshot = new Map<string, Partial<Project>>();
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        prevSnapshot.set(p.id, { priority: p.priority, dueDate: p.dueDate });
        return { ...p, ...patch };
      }),
    );
    const result = await projectsApi.update(projectId, apiPayload);
    if (!result.success) {
      toast.error(t.allProjects.projectUpdateFailed);
      setProjects((prev) =>
        prev.map((p) => {
          const snap = prevSnapshot.get(p.id);
          return snap ? { ...p, ...snap } : p;
        }),
      );
    }
  }, [t.allProjects.projectUpdateFailed]);

  // Delete project
  const deleteProject = useCallback(async (projectId: string) => {
    startTransition(async () => {
      const result = await projectsApi.delete(projectId);
      if (result.success) {
        setProjects(prev => prev.filter(p => p.id !== projectId));
        toast.success(t.allProjects.projectDeleted);
      } else {
        toast.error(t.allProjects.projectDeleteFailed);
      }
    });
  }, [t.allProjects.projectDeleted, t.allProjects.projectDeleteFailed]);

  // Bulk delete
  const confirmBulkDelete = async () => {
    setIsDeleting(true);
    let successCount = 0;
    for (const id of selectedRows) {
      const result = await projectsApi.delete(id);
      if (result.success) successCount++;
    }
    setIsDeleting(false);
    setShowDeleteDialog(false);
    setSelectedRows(new Set());
    if (successCount > 0) {
      setProjects(prev => prev.filter(p => !selectedRows.has(p.id)));
      toast.success(successCount > 1 ? t.allProjects.bulkDeletedPlural.replace('{n}', String(successCount)) : t.allProjects.bulkDeletedSingular);
    }
  };

  const formatDateShort = (dateString: string) => {
    if (!dateString) return null;
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: t.allProjects.filterStatus,
      options: [
        { value: 'on-track', label: t.allProjects.statusOnTrack },
        { value: 'at-risk', label: t.allProjects.statusAtRisk },
        { value: 'off-track', label: t.allProjects.statusOffTrack },
        { value: 'on-hold', label: t.allProjects.statusOnHold },
        { value: 'completed', label: t.allProjects.statusCompleted },
      ],
    },
    {
      field: 'priority',
      label: t.allProjects.filterPriority,
      options: [
        { value: 'critical', label: t.allProjects.priorityCritical },
        { value: 'high', label: t.allProjects.priorityHigh },
        { value: 'medium', label: t.allProjects.priorityMedium },
        { value: 'low', label: t.allProjects.priorityLow },
      ],
    },
    {
      field: 'owner',
      label: t.allProjects.filterOwner,
      options: [...new Set(projects.map(p => p.owner.name))].map(name => ({ value: name, label: name })),
    },
  ], [projects, t]);

  // Apply filters
  const applyFilters = useCallback((items: Project[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(p => p.status === filter.value)
          : result.filter(p => p.status !== filter.value);
      } else if (filter.field === 'priority') {
        result = filter.operator === 'is'
          ? result.filter(p => p.priority === filter.value)
          : result.filter(p => p.priority !== filter.value);
      } else if (filter.field === 'owner') {
        result = filter.operator === 'is'
          ? result.filter(p => p.owner.name === filter.value)
          : result.filter(p => p.owner.name !== filter.value);
      }
    });
    return result;
  }, []);

  // Sort
  const handleSort = useCallback((columnId: string) => {
    setSortState(prev => {
      if (prev?.columnId === columnId) {
        if (prev.direction === 'asc') return { columnId, direction: 'desc' as const };
        return null;
      }
      return { columnId, direction: 'asc' as const };
    });
  }, [setSortState]);

  const priorityOrder = useMemo(() => ['low', 'medium', 'high', 'critical'], []);
  const statusOrder = useMemo(() => ['on-track', 'at-risk', 'off-track', 'on-hold', 'completed'], []);

  const sortedProjects = useMemo(() => {
    if (!sortState) return projects;
    const { columnId, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;

    return [...projects].sort((a, b) => {
      switch (columnId) {
        case 'status':
          return (statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)) * dir;
        case 'priority':
          return (priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)) * dir;
        case 'progress':
          return (a.progress - b.progress) * dir;
        case 'dueDate': {
          const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
          const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
          return (aTime - bTime) * dir;
        }
        case 'owner':
          return a.owner.name.localeCompare(b.owner.name) * dir;
        default:
          return 0;
      }
    });
  }, [projects, sortState, priorityOrder, statusOrder]);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'project', header: t.allProjects.columnProject, width: 'min-w-[200px] flex-1' },
    { id: 'status', header: t.allProjects.columnStatus, width: 'w-[120px]', sortable: true },
    { id: 'priority', header: t.allProjects.columnPriority, width: 'w-[100px]', sortable: true },
    { id: 'progress', header: t.allProjects.columnProgress, width: 'w-[200px]', sortable: true },
    { id: 'owner', header: t.allProjects.columnOwner, width: 'w-[130px]', sortable: true },
    { id: 'dueDate', header: t.allProjects.columnDueDate, width: 'w-[100px]', sortable: true },
  ], [t]);

  // Render row
  const renderRow = useCallback((project: Project) => {
    const status = statusConfig[project.status];
    const priority = priorityConfig[project.priority];

    return (
      <div
        key={project.id}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
        onClick={() => router.push(`/weldflow/project/${project.id}/tasks`)}
      >
        {/* Project Name */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2.5">
          <div className={cn("w-6 h-6 rounded-[8px] flex items-center justify-center flex-shrink-0", project.color || 'bg-muted')}>
            {(() => {
              const IconComp = project.icon ? (coloredSquareIcons.find(i => i.label === project.icon)?.value || FolderKanban) : FolderKanban;
              return <IconComp className={cn("h-3.5 w-3.5", project.color ? "text-white" : "text-muted-foreground")} />;
            })()}
          </div>
          <Link
            href={`/weldflow/project/${project.id}/tasks`}
            className="text-sm font-medium text-foreground truncate hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {project.name}
          </Link>
        </div>

        {/* Status (auto-derived from tasks + due date) */}
        <div className="w-[120px]">
          <span className={cn("inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none", status.color, status.bg)}>
            {status.label}
          </span>
        </div>

        {/* Priority */}
        <div className="w-[100px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  "inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 transition-shadow",
                  priority ? cn(priority.color, priority.bg) : "text-gray-400 bg-transparent",
                )}
              >
                {priority ? priority.label : '—'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              {Object.entries(priorityConfig).map(([key, cfg]) => (
                <Button
                  key={key}
                  variant="ghost"
                  onClick={() => updateProjectInline(project.id, { priority: key }, { priority: key })}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded gap-4"
                >
                  <span>{cfg.label}</span>
                  {project.priority === key && <Check className="h-3.5 w-3.5 text-primary" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {/* Progress */}
        <div className="w-[200px] flex items-center gap-3 pr-8">
          <div className="flex-1 bg-muted rounded-full h-[5px]">
            <div className="h-[5px] rounded-full bg-foreground" style={{ width: `${project.progress}%` }} />
          </div>
          <span className="text-[12px] text-muted-foreground font-medium flex-shrink-0 w-9 text-left tabular-nums">{project.progress}%</span>
        </div>

        {/* Owner */}
        <div className="w-[130px] min-w-0" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            className="group/owner flex items-center gap-1.5 max-w-full min-w-0 rounded px-1 py-0.5 -mx-1 cursor-pointer"
            onClick={() => {
              if (project.owner.userId) {
                setSelectedMember({
                  id: project.owner.userId,
                  name: project.owner.name,
                  email: project.owner.email || '',
                  avatar: project.owner.avatar,
                  role: (project.owner.role || 'MEMBER').toUpperCase(),
                  status: 'ACTIVE',
                  joinedAt: project.owner.joinedAt || new Date().toISOString(),
                  userId: project.owner.userId,
                });
              }
            }}
          >
            <Avatar className="h-5 w-5 !rounded-[7px]">
              {project.owner.avatar && (
                <AvatarImage src={project.owner.avatar} alt={project.owner.name} className="!rounded-[7px]" />
              )}
              <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                {project.owner.name.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="text-sm text-gray-600 dark:text-muted-foreground truncate group-hover/owner:underline">
              {project.owner.name.split(' ')[0]}
            </span>
          </Button>
        </div>

        {/* Due Date */}
        <div className="w-[100px]" onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="text-sm cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 rounded px-1 py-0.5 transition-shadow">
                {project.dueDate ? (
                  <span className="text-muted-foreground font-mono">{formatDateShort(project.dueDate)}</span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end" sideOffset={4} collisionPadding={12}>
              <Calendar
                mode="single"
                selected={project.dueDate ? new Date(project.dueDate + 'T00:00:00') : undefined}
                onSelect={(date) => {
                  const iso = date ? date.toISOString().split('T')[0] : '';
                  updateProjectInline(
                    project.id,
                    { dueDate: iso },
                    { endDate: date ? date.toISOString() : undefined },
                  );
                }}
                initialFocus
              />
              {project.dueDate && (
                <div className="p-1 border-t border-border">
                  <Button
                    variant="ghost"
                    onClick={() => updateProjectInline(project.id, { dueDate: '' }, { endDate: '' })}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    <span>{t.allProjects.clearDate}</span>
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
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
              <DropdownMenuItem asChild>
                <Link href={`/weldflow/project/${project.id}/tasks`}>
                  <Pencil className="h-3.5 w-3.5 mr-0.5" />
                  {t.allProjects.actionOpen}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                onClick={() => deleteProject(project.id)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-600" />
                {t.allProjects.actionDelete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [deleteProject, setSelectedMember, router, updateProjectInline, priorityConfig, statusConfig, t.allProjects.actionDelete, t.allProjects.actionOpen, t.allProjects.clearDate]);

  return (
    <div className="-mx-3 md:-mx-4 -mt-3 md:-mt-4">
      <EntityList<Project>
        items={sortedProjects}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        maxFilters={5}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={t.allProjects.searchPlaceholder}
        searchFields={['name']}
        sortState={sortState}
        onSort={handleSort}
        searchQuery={searchQueryProp}
        onSearchChange={onSearchChange}
        activeFilters={activeFiltersProp}
        onFiltersChange={onFiltersChange}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={onLoadMore}
        topBarClassName="pt-2 pb-2"
        stickyOffset={-16}
        createButton={{
          label: t.allProjects.newProject,
          onClick: () => setShowAddDialog(true),
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H96C98.2 34 100 35.8 100 38V92C100 94.2 98.2 96 96 96H24C21.8 96 20 94.2 20 92V30Z" className="fill-white dark:fill-white/[0.03]" />
                <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H20V30Z" className="fill-gray-50 dark:fill-white/[0.06]" />
                <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H96C98.2 34 100 35.8 100 38V92C100 94.2 98.2 96 96 96H24C21.8 96 20 94.2 20 92V30Z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                <rect x="32" y="46" width="34" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.5" />
                <rect x="32" y="53" width="24" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.35" />
                <rect x="32" y="63" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
                <rect x="32" y="70" width="20" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.25" />
                <rect x="32" y="80" width="26" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.3" />
                <rect x="32" y="87" width="16" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.2" />
                <rect x="76" y="45" width="12" height="5" rx="2.5" className="fill-gray-100 dark:fill-white/15" />
                <rect x="76" y="62" width="12" height="5" rx="2.5" className="fill-gray-100 dark:fill-white/15" />
                <rect x="76" y="79" width="12" height="5" rx="2.5" className="fill-gray-100 dark:fill-white/15" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t.allProjects.emptyTitle,
          description: t.allProjects.emptyDescription,
          action: {
            label: t.allProjects.newProject,
            onClick: () => setShowAddDialog(true),
          },
        }}
        noResultsState={{
          title: t.allProjects.noResultsTitle,
          description: t.allProjects.noResultsDescription,
        }}
      />

      {/* Selection Action Bar */}
      {selectedRows.size > 0 && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-20 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-center gap-1 bg-background border rounded-xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.1)] px-2 py-1.5">
            <div className="flex items-center gap-1.5 px-2">
              <span className="text-sm font-medium">{selectedRows.size}</span>
              <span className="text-sm text-muted-foreground">{t.allProjects.selected}</span>
            </div>
            <div className="w-px h-5 bg-border" />
            <Button variant="ghost" size="sm" className="h-8 px-3 text-sm gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => setShowDeleteDialog(true)} disabled={isDeleting}>
              <Trash2 className="h-4 w-4" />
              {isDeleting ? t.allProjects.deleting : t.allProjects.actionDelete}
            </Button>
            <div className="w-px h-5 bg-border" />
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setSelectedRows(new Set())}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title={selectedRows.size > 1 ? t.allProjects.bulkDeleteTitlePlural.replace('{n}', String(selectedRows.size)) : t.allProjects.bulkDeleteTitleSingular}
        description={t.allProjects.bulkDeleteDescription}
        variant="destructive"
        confirmLabel={t.allProjects.actionDelete}
        loading={isDeleting}
        onConfirm={confirmBulkDelete}
      />

      {/* Add Project Dialog */}
      <Dialog
        open={showAddDialog}
        onOpenChange={(open) => {
          if (!open) {
            setNewProjectName('');
            setNewProjectPriority('medium');
            setSelectedColor(coloredSquareColors[0].value);
            setSelectedIcon(coloredSquareIcons[0].value);
          }
          setShowAddDialog(open);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t.allProjects.addDialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">{t.allProjects.nameLabel}</Label>
              <div className="flex items-center gap-2">
                <Popover open={colorPopoverOpen} onOpenChange={setColorPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(
                        'w-9 h-9 rounded-md flex items-center justify-center shrink-0 transition-all hover:scale-105 border border-transparent hover:border-border',
                        selectedColor
                      )}
                      title={t.allProjects.changeColor}
                    >
                      {React.createElement(selectedIcon, { className: 'h-4 w-4 text-white' })}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="grid grid-cols-6 gap-1.5">
                      {coloredSquareColors.map((color) => (
                        <Button
                          key={color.value}
                          type="button"
                          variant="ghost"
                          className={cn(
                            'w-7 h-7 rounded-md transition-all hover:scale-110',
                            color.value,
                            selectedColor === color.value && 'ring-2 ring-offset-1 ring-primary'
                          )}
                          onClick={() => {
                            setSelectedColor(color.value);
                            setColorPopoverOpen(false);
                          }}
                          title={color.label}
                        />
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                <Popover open={iconPopoverOpen} onOpenChange={setIconPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 border border-border hover:border-muted-foreground/30 hover:bg-muted/50 transition-colors"
                      title={t.allProjects.changeIcon}
                    >
                      {React.createElement(selectedIcon, { className: 'h-4 w-4' })}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="grid grid-cols-7 gap-1.5">
                      {coloredSquareIcons.map((iconOption) => (
                        <Button
                          key={iconOption.label}
                          type="button"
                          variant="ghost"
                          className={cn(
                            'w-7 h-7 rounded-md flex items-center justify-center transition-colors hover:bg-accent',
                            selectedIcon === iconOption.value && 'bg-accent ring-2 ring-primary'
                          )}
                          onClick={() => {
                            setSelectedIcon(iconOption.value);
                            setIconPopoverOpen(false);
                          }}
                          title={iconOption.label}
                        >
                          {React.createElement(iconOption.value, { className: 'h-4 w-4' })}
                        </Button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                <Input
                  id="project-name"
                  placeholder={t.allProjects.namePlaceholder}
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newProjectName.trim()) {
                      handleAddProject();
                    }
                  }}
                  autoFocus
                  className="flex-1"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowAddDialog(false);
                setNewProjectName('');
                setNewProjectPriority('medium');
                setSelectedColor(coloredSquareColors[0].value);
                setSelectedIcon(coloredSquareIcons[0].value);
              }}
            >
              {t.allProjects.cancel}
            </Button>
            <Button onClick={handleAddProject} disabled={!newProjectName.trim() || loading}>
              {t.allProjects.createProject}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Team Member Details Panel */}
      <TeamMemberDetailsPanel
        member={selectedMember}
        isOpen={!!selectedMember}
        onClose={() => setSelectedMember(null)}
        canManageMembers={false}
        onRemoveMember={() => {}}
        onMemberUpdated={() => {}}
        context="projects"
      />
    </div>
  );
}
