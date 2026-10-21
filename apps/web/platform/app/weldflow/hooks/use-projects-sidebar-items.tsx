
import * as React from 'react';
import {
  FolderKanban,
  SquareCheck,
  Users,
  PanelsTopLeft,
  BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import { coloredSquareColorLabel, coloredSquareColors, coloredSquareIconLabel, coloredSquareIcons, findColoredSquareIconByLabel } from '@/components/app-sidebar-layout';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DeleteProjectDialog } from '../components/delete-project-dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { projectsApi, stagesApi, type ApiProject } from '../lib/api-client';
import { toast } from 'sonner';
import { useDataEvent } from '@/lib/events/data-events';
import { useTopic } from '@weldsuite/realtime/react';
import { usePathname, useRouter } from '@/lib/router';
import { useSidebarProjectOrder } from '@/hooks/queries/use-weldflow-preferences';

const findIconByLabel = findColoredSquareIconByLabel;

const PROJECT_HREF_PREFIX = '/weldflow/project/';

/** The project id behind a sidebar item's href (`/weldflow/project/:id`). */
function projectIdFromHref(href: string | undefined): string {
  return (href ?? '').slice(PROJECT_HREF_PREFIX.length);
}

/**
 * Orders sidebar items by the user's saved project order. Projects missing from
 * the saved order (new ones) keep their relative position after the saved ones.
 */
function applyProjectOrder(pages: MenuItemProps[], order: readonly string[] | null): MenuItemProps[] {
  if (!order || order.length === 0) return pages;
  const rank = new Map(order.map((id, index) => [id, index]));
  const unranked = order.length;
  return pages
    .map((page, index) => ({ page, index }))
    .sort((a, b) => {
      const rankA = rank.get(projectIdFromHref(a.page.href)) ?? unranked;
      const rankB = rank.get(projectIdFromHref(b.page.href)) ?? unranked;
      return rankA - rankB || a.index - b.index;
    })
    .map(({ page }) => page);
}

/** Returns `value` when `allowed`, otherwise `undefined` (used for permission-gated menu actions). */
function whenAllowed<T>(allowed: boolean, value: T): T | undefined {
  return allowed ? value : undefined;
}

function resolveProjectIcon(iconLabel: string | null | undefined): LucideIcon {
  return (iconLabel ? findIconByLabel(iconLabel) : undefined) || FolderKanban;
}

export function useProjectsSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
  dialogs: React.ReactNode;
} {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [projectPages, setProjectPages] = React.useState<MenuItemProps[]>([]);
  // The user's own project order is a saved preference (follows them across
  // devices); the refs let the stable handlers below read the latest values.
  const { order: savedProjectOrder, setOrder: saveProjectOrder } = useSidebarProjectOrder();
  const savedProjectOrderRef = React.useRef(savedProjectOrder);
  const projectPagesRef = React.useRef(projectPages);
  const pathnameRef = React.useRef(pathname);
  React.useEffect(() => {
    savedProjectOrderRef.current = savedProjectOrder;
    // The saved order can arrive after the projects did.
    setProjectPages((prev) => applyProjectOrder(prev, savedProjectOrder));
  }, [savedProjectOrder]);
  React.useEffect(() => {
    projectPagesRef.current = projectPages;
  }, [projectPages]);
  React.useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);
  const [showAddProjectDialog, setShowAddProjectDialog] = React.useState(false);
  const [newProjectName, setNewProjectName] = React.useState('');
  const [isCreatingProject, setIsCreatingProject] = React.useState(false);
  // Set synchronously so a second click (or Enter) that lands before React
  // re-renders with the disabled button cannot start a second create.
  const isCreatingProjectRef = React.useRef(false);
  const [selectedColor, setSelectedColor] = React.useState(coloredSquareColors[0].value);
  const [selectedIcon, setSelectedIcon] = React.useState<LucideIcon>(coloredSquareIcons[0].value);
  const [colorPopoverOpen, setColorPopoverOpen] = React.useState(false);
  const [iconPopoverOpen, setIconPopoverOpen] = React.useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [projectToDelete, setProjectToDelete] = React.useState<{ id: string; name: string } | null>(null);
  const [showRenameDialog, setShowRenameDialog] = React.useState(false);
  const [projectToRename, setProjectToRename] = React.useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [renameColor, setRenameColor] = React.useState(coloredSquareColors[0].value);
  const [renameIcon, setRenameIcon] = React.useState<LucideIcon>(coloredSquareIcons[0].value);
  const [renameColorPopoverOpen, setRenameColorPopoverOpen] = React.useState(false);
  const [renameIconPopoverOpen, setRenameIconPopoverOpen] = React.useState(false);

  // Track which general pages are visible
  const [visibleGeneralPages, setVisibleGeneralPages] = React.useState<Set<string>>(
    new Set(['my-tasks', 'all-projects', 'workload', 'analytics', 'timeline', 'list'])
  );

  // Load visible general pages from localStorage
  React.useEffect(() => {
    if (!isActive) return;
    const saved = localStorage.getItem('visibleGeneralPages');
    if (saved) {
      const savedPages = new Set<string>(JSON.parse(saved));
      let dirty = false;
      // Remove legacy my-inbox entry if present
      if (savedPages.has('my-inbox')) {
        savedPages.delete('my-inbox');
        dirty = true;
      }
      // Merge Analytics in for users who saved prefs before it existed
      if (!savedPages.has('analytics')) {
        savedPages.add('analytics');
        dirty = true;
      }
      if (dirty) {
        localStorage.setItem('visibleGeneralPages', JSON.stringify(Array.from(savedPages)));
      }
      setVisibleGeneralPages(savedPages);
    }
  }, [isActive]);

  // Save visible general pages to localStorage whenever it changes
  React.useEffect(() => {
    if (!isActive) return;
    localStorage.setItem('visibleGeneralPages', JSON.stringify(Array.from(visibleGeneralPages)));
  }, [isActive, visibleGeneralPages]);

  // Refs to break circular dependencies
  const reloadProjectsRef = React.useRef<() => Promise<void>>(async () => {});
  const handleMoveProjectRef = React.useRef<(projectHref: string, direction: 'up' | 'down') => void>(() => {});
  const handleDuplicateProjectRef = React.useRef<(projectId: string) => Promise<void>>(async () => {});

  // Transform API projects to menu items
  const transformProjectsToMenuItems = React.useCallback((projects: ApiProject[]) => {
    return projects.map((project) => {
      const projectId = project.id;
      const canWrite = project.canWrite ?? true;
      const isAdmin = project.isAdmin ?? true;

      // Resolve icon from stored label or fallback
      const resolvedIcon = resolveProjectIcon(project.icon);

      return {
        title: project.name,
        href: `/weldflow/project/${projectId}`,
        icon: resolvedIcon,
        iconStyle: 'colored-square' as const,
        iconColor: project.color || coloredSquareColors[0].value,
        subItems: [],
        onRename: whenAllowed(canWrite, () => {
          setProjectToRename({ id: projectId, name: project.name });
          setRenameValue(project.name);
          setRenameColor(project.color || coloredSquareColors[0].value);
          setRenameIcon(resolvedIcon);
          setShowRenameDialog(true);
        }),
        onDuplicate: whenAllowed(canWrite, () => {
          void handleDuplicateProjectRef.current(projectId);
        }),
        onDelete: whenAllowed(isAdmin, () => {
          setProjectToDelete({ id: projectId, name: project.name });
          setShowDeleteDialog(true);
        }),
        onChangeColor: whenAllowed(canWrite, async (color: string) => {
          await projectsApi.update(projectId, { color });
          await reloadProjectsRef.current();
        }),
        onChangeIcon: whenAllowed(canWrite, async (icon: LucideIcon) => {
          const iconLabel = coloredSquareIcons.find((i) => i.value === icon)?.label || '';
          await projectsApi.update(projectId, { icon: iconLabel });
          await reloadProjectsRef.current();
        }),
        onMoveUp: () => handleMoveProjectRef.current(`/weldflow/project/${projectId}`, 'up'),
        onMoveDown: () => handleMoveProjectRef.current(`/weldflow/project/${projectId}`, 'down'),
      };
    });
  }, []);

  // Reload projects from API
  const reloadProjects = React.useCallback(async () => {
    if (!isActive) return;
    const result = await projectsApi.list();
    if (result.success && result.data) {
      const projectsWithHandlers = transformProjectsToMenuItems(result.data);
      // Preserve existing sidebar order: match current items first, then append new ones
      setProjectPages((prev) => {
        // First load: the user's saved order (API order when there is none).
        if (prev.length === 0) return applyProjectOrder(projectsWithHandlers, savedProjectOrderRef.current);
        const prevHrefs = prev.map((p) => p.href);
        const ordered: typeof projectsWithHandlers = [];
        for (const href of prevHrefs) {
          const found = projectsWithHandlers.find((p) => p.href === href);
          if (found) ordered.push(found);
        }
        // Append any new projects not in previous list
        for (const p of projectsWithHandlers) {
          if (!prevHrefs.includes(p.href)) ordered.push(p);
        }
        return ordered;
      });
    }
  }, [isActive, transformProjectsToMenuItems]);

  React.useEffect(() => {
    reloadProjectsRef.current = reloadProjects;
  }, [reloadProjects]);

  // Move project up or down in sidebar
  const persistProjectOrder = React.useCallback(
    (pages: MenuItemProps[]) => saveProjectOrder(pages.map((page) => projectIdFromHref(page.href))),
    [saveProjectOrder],
  );

  const handleMoveProject = React.useCallback((projectHref: string, direction: 'up' | 'down') => {
    const current = projectPagesRef.current;
    const index = current.findIndex((p) => p.href === projectHref);
    if (index === -1) return;
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === current.length - 1) return;
    const newPages = [...current];
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    [newPages[index], newPages[swapIndex]] = [newPages[swapIndex], newPages[index]];
    setProjectPages(newPages);
    persistProjectOrder(newPages);
  }, [persistProjectOrder]);

  React.useEffect(() => {
    handleMoveProjectRef.current = handleMoveProject;
  }, [handleMoveProject]);

  // Duplicate a project: a new project with the same settings and (custom)
  // statuses. Tasks and files are intentionally not copied.
  const handleDuplicateProject = React.useCallback(async (projectId: string) => {
    const source = await projectsApi.get(projectId);
    if (!source.success || !source.data) {
      toast.error(t.projects.sidebar.error, {
        description: source.error || t.projects.sidebar.projectDuplicateFailed,
      });
      return;
    }
    const project = source.data;
    const copyName = `${project.name} (${t.projects.sidebar.copySuffix})`;
    const created = await projectsApi.create({
      name: copyName,
      description: project.description ?? undefined,
      status: project.status,
      priority: project.priority,
      color: project.color ?? undefined,
      icon: project.icon ?? undefined,
      startDate: project.startDate ?? undefined,
      endDate: project.endDate ?? undefined,
    });
    if (!created.success || !created.data) {
      toast.error(t.projects.sidebar.error, {
        description: created.error || t.projects.sidebar.projectDuplicateFailed,
      });
      return;
    }

    // Carry the statuses over (in order). Best-effort: without any, the new
    // project simply seeds the default set on first use.
    const stages = await stagesApi.list(projectId);
    if (stages.success && stages.data && stages.data.length > 0) {
      const ordered = [...stages.data].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      for (const [position, stage] of ordered.entries()) {
        const copied = await stagesApi.create(created.data.id, {
          name: stage.name,
          color: stage.color ?? undefined,
          position,
          systemStatus: stage.systemStatus ?? undefined,
        });
        if (!copied.success) break;
      }
    }

    await reloadProjects();
    toast.success(t.projects.sidebar.projectDuplicated, {
      description: t.projects.sidebar.projectDuplicatedDescription.replace('{name}', copyName),
    });
  }, [reloadProjects, t.projects.sidebar.error, t.projects.sidebar.projectDuplicateFailed, t.projects.sidebar.copySuffix, t.projects.sidebar.projectDuplicated, t.projects.sidebar.projectDuplicatedDescription]);

  React.useEffect(() => {
    handleDuplicateProjectRef.current = handleDuplicateProject;
  }, [handleDuplicateProject]);

  // Listen for projects:changed events
  useDataEvent('projects:changed', reloadProjects);

  // Subscribe to real-time project events from Cloudflare DO
  useTopic('project', reloadProjects);
  useTopic('project_member', reloadProjects);

  const handleProjectDeleted = React.useCallback(
    async (projectId: string, movedTo: { id: string } | null) => {
      // Deleting the project you are looking at must not leave you on its dead page;
      // when its tasks moved, follow them.
      const projectBase = `${PROJECT_HREF_PREFIX}${projectId}`;
      const viewing = pathnameRef.current ?? '';
      if (viewing === projectBase || viewing.startsWith(`${projectBase}/`)) {
        router.replace(movedTo ? `${PROJECT_HREF_PREFIX}${movedTo.id}/tasks` : '/weldflow/projects');
      }
      await reloadProjects();
    },
    [reloadProjects, router]
  );

  // Initialize projects
  React.useEffect(() => {
    if (!isActive) return;
    void reloadProjects();
  }, [isActive, reloadProjects]);

  const handleAddProject = () => {
    setShowAddProjectDialog(true);
  };

  const handleRenameProject = async () => {
    if (!renameValue.trim() || !projectToRename) return;
    const iconLabel = coloredSquareIcons.find((i) => i.value === renameIcon)?.label || '';
    const result = await projectsApi.update(projectToRename.id, {
      name: renameValue.trim(),
      color: renameColor,
      icon: iconLabel,
    });
    if (result.success) {
      // Update in-place so sidebar order is preserved
      setProjectPages((prev) =>
        prev.map((item) =>
          item.href?.startsWith(`/weldflow/project/${projectToRename.id}`)
            ? { ...item, title: renameValue.trim(), icon: renameIcon, iconColor: renameColor }
            : item
        )
      );
      // Notify layout header without triggering full sidebar reload
      window.dispatchEvent(new CustomEvent('project:renamed', { detail: { id: projectToRename.id, name: renameValue.trim() } }));
      setShowRenameDialog(false);
      setProjectToRename(null);
      setRenameValue('');
      toast.success(t.projects.sidebar.projectUpdated);
    } else {
      toast.error(result.error || t.projects.sidebar.projectUpdateFailed);
    }
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim() || isCreatingProjectRef.current) return;
    isCreatingProjectRef.current = true;
    setIsCreatingProject(true);
    try {
      const projectName = newProjectName;
      const iconLabel = coloredSquareIcons.find((i) => i.value === selectedIcon)?.label || '';
      const result = await projectsApi.create({
        name: projectName,
        status: 'Planning',
        priority: 'medium',
        color: selectedColor,
        icon: iconLabel,
      });

      if (result.success && result.data) {
        await reloadProjects();
        setShowAddProjectDialog(false);
        setNewProjectName('');
        setSelectedColor(coloredSquareColors[0].value);
        setSelectedIcon(coloredSquareIcons[0].value);
        toast.success(t.projects.sidebar.projectCreated, {
          description: t.projects.sidebar.projectCreatedDescription.replace('{name}', projectName),
        });
      } else {
        toast.error(t.projects.sidebar.error, {
          description: result.error || t.projects.sidebar.projectCreateFailed,
        });
      }
    } finally {
      isCreatingProjectRef.current = false;
      setIsCreatingProject(false);
    }
  };

  if (!isActive) {
    return { menuGroups: [], dialogs: null };
  }

  // Define all available general pages
  const allGeneralPages: Array<{ id: string } & MenuItemProps> = [
    { id: 'my-tasks', title: t.projects.sidebar.myTasks, href: '/weldflow', icon: SquareCheck, actions: [] },
    { id: 'all-projects', title: t.projects.sidebar.allProjects, href: '/weldflow/projects', icon: PanelsTopLeft, actions: [] },
    { id: 'workload', title: t.projects.sidebar.workload, href: '/weldflow/workload', icon: Users, actions: [] },
    { id: 'analytics', title: t.projects.sidebar.analytics, href: '/weldflow/analytics', icon: BarChart3, actions: [] },
  ];

  const visibleGeneralItems = allGeneralPages.filter((page) => visibleGeneralPages.has(page.id));

  const menuGroups: MenuGroupProps[] = [
    {
      group: t.projects.sidebar.general,
      items: visibleGeneralItems,
    },
    {
      group: t.projects.sidebar.projects,
      // Only offer a move that has somewhere to go (no "Move Up" on the first
      // project, no "Move Down" on the last, neither when there is just one).
      items: projectPages.map((page, index) => ({
        ...page,
        onMoveUp: index === 0 ? undefined : page.onMoveUp,
        onMoveDown: index === projectPages.length - 1 ? undefined : page.onMoveDown,
      })),
      onAdd: handleAddProject,
      // Keep the header + empty-state "Add project" button visible when there
      // are no projects yet, so the user can create one from the sidebar.
      keepWhenEmpty: true,
      addLabel: t.projects.sidebar.addProject,
      draggable: true,
      // The items handed back carry the per-position move gating above; map them
      // back to the stored items so those callbacks are not lost after a reorder.
      onReorder: (reorderedItems) => {
        const reordered = reorderedItems.map((item) => projectPages.find((page) => page.href === item.href) ?? item);
        setProjectPages(reordered);
        persistProjectOrder(reordered);
      },
    },
  ];

  const dialogs = (
    <>
      {/* Add Project Dialog */}
      <Dialog
        open={showAddProjectDialog}
        onOpenChange={(open) => {
          if (!open) {
            setNewProjectName('');
            setSelectedColor(coloredSquareColors[0].value);
            setSelectedIcon(coloredSquareIcons[0].value);
          }
          setShowAddProjectDialog(open);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t.projects.sidebar.addProjectTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">{t.projects.sidebar.nameLabel}</Label>
              <div className="flex items-center gap-2">
                {/* Color Dropdown */}
                <Popover open={colorPopoverOpen} onOpenChange={setColorPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(
                        'w-9 h-9 rounded-md flex items-center justify-center shrink-0 transition-all hover:scale-105 border border-transparent hover:border-gray-300',
                        selectedColor
                      )}
                      title={t.projects.sidebar.changeColor}
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
                          size="icon"
                          className={cn(
                            'w-7 h-7 rounded-md transition-all hover:scale-110',
                            color.value,
                            selectedColor === color.value && 'ring-2 ring-offset-1 ring-primary'
                          )}
                          onClick={() => {
                            setSelectedColor(color.value);
                            setColorPopoverOpen(false);
                          }}
                          title={coloredSquareColorLabel(t.common.coloredSquare, color.label)}
                        />
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Icon Dropdown */}
                <Popover open={iconPopoverOpen} onOpenChange={setIconPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                      title={t.projects.sidebar.changeIcon}
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
                          size="icon"
                          className={cn(
                            'w-8 h-8 rounded-md flex items-center justify-center border border-transparent transition-colors hover:bg-accent',
                            selectedIcon === iconOption.value && 'bg-muted border-border'
                          )}
                          onClick={() => {
                            setSelectedIcon(iconOption.value);
                            setIconPopoverOpen(false);
                          }}
                          title={coloredSquareIconLabel(t.common.coloredSquare, iconOption.label)}
                        >
                          {React.createElement(iconOption.value, { className: 'h-4 w-4' })}
                        </Button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Name Input */}
                <Input
                  id="project-name"
                  placeholder={t.projects.sidebar.namePlaceholder}
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newProjectName.trim()) {
                      void handleCreateProject();
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
                setShowAddProjectDialog(false);
                setNewProjectName('');
                setSelectedColor(coloredSquareColors[0].value);
                setSelectedIcon(coloredSquareIcons[0].value);
              }}
            >
              {t.projects.sidebar.cancel}
            </Button>
            <Button onClick={handleCreateProject} disabled={!newProjectName.trim() || isCreatingProject}>
              {t.projects.sidebar.createProject}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Project Dialog */}
      <Dialog
        open={showRenameDialog}
        onOpenChange={(open) => {
          if (!open) {
            setProjectToRename(null);
            setRenameValue('');
          }
          setShowRenameDialog(open);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t.projects.sidebar.editProjectTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rename-project">{t.projects.sidebar.nameLabel}</Label>
              <div className="flex items-center gap-2">
                {/* Color Dropdown */}
                <Popover open={renameColorPopoverOpen} onOpenChange={setRenameColorPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(
                        'w-9 h-9 rounded-md flex items-center justify-center shrink-0 transition-all hover:scale-105 border border-transparent hover:border-gray-300',
                        renameColor,
                      )}
                      title={t.projects.sidebar.changeColor}
                    >
                      {React.createElement(renameIcon, { className: 'h-4 w-4 text-white' })}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="grid grid-cols-6 gap-1.5">
                      {coloredSquareColors.map((color) => (
                        <Button
                          key={color.value}
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={cn(
                            'w-7 h-7 rounded-md transition-all hover:scale-110',
                            color.value,
                            renameColor === color.value && 'ring-2 ring-offset-1 ring-primary',
                          )}
                          onClick={() => {
                            setRenameColor(color.value);
                            setRenameColorPopoverOpen(false);
                          }}
                          title={coloredSquareColorLabel(t.common.coloredSquare, color.label)}
                        />
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Icon Dropdown */}
                <Popover open={renameIconPopoverOpen} onOpenChange={setRenameIconPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                      title={t.projects.sidebar.changeIcon}
                    >
                      {React.createElement(renameIcon, { className: 'h-4 w-4' })}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="grid grid-cols-7 gap-1.5">
                      {coloredSquareIcons.map((iconOption) => (
                        <Button
                          key={iconOption.label}
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={cn(
                            'w-8 h-8 rounded-md flex items-center justify-center border border-transparent transition-colors hover:bg-accent',
                            renameIcon === iconOption.value && 'bg-muted border-border',
                          )}
                          onClick={() => {
                            setRenameIcon(iconOption.value);
                            setRenameIconPopoverOpen(false);
                          }}
                          title={coloredSquareIconLabel(t.common.coloredSquare, iconOption.label)}
                        >
                          {React.createElement(iconOption.value, { className: 'h-4 w-4' })}
                        </Button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Name Input */}
                <Input
                  id="rename-project"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && renameValue.trim()) {
                      e.preventDefault();
                      void handleRenameProject();
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
                setShowRenameDialog(false);
                setProjectToRename(null);
                setRenameValue('');
              }}
            >
              {t.projects.sidebar.cancel}
            </Button>
            <Button onClick={handleRenameProject} disabled={!renameValue.trim()}>
              {t.projects.sidebar.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Project Confirmation Dialog */}
      <DeleteProjectDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        project={projectToDelete}
        onDeleted={handleProjectDeleted}
      />
    </>
  );

  return { menuGroups, dialogs };
}
