
import * as React from 'react';
import { useParams, usePathname, useRouter, Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import {
  File,
  GanttChart,
  Table2,
  SquareDashedMousePointer,
  Target,
  SquareKanban,
  Users,
  Timer,
  SquareCheck,
  Folder,
  Settings,
  PanelLeftOpen,
  PanelRightOpen,
  type LucideIcon,
} from 'lucide-react';
import { ProjectChatPanel } from '@/components/project-chat/project-chat-panel';
import { useObjectPanelStack } from '@/components/object-panel';
import { cn } from '@/lib/utils';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@weldsuite/ui/components/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { EyeOff, ArrowLeft, ArrowRight, Plus } from 'lucide-react';
import { ProjectPermissionProvider } from '@/app/weldflow/contexts/project-permission-context';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { projectsApi } from '@/app/weldflow/lib/api-client';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface ProjectTab {
  id: string;
  name: string;
  href: string;
  icon: LucideIcon;
}

const defaultProjectTabs: ProjectTab[] = [
  { id: 'tasks', name: 'Tasks', href: '/tasks', icon: SquareCheck },
  { id: 'gantt', name: 'Gantt', href: '/gantt', icon: GanttChart },
  { id: 'table', name: 'Sheets', href: '/table', icon: Table2 },
  { id: 'whiteboard', name: 'Whiteboard', href: '/whiteboard', icon: SquareDashedMousePointer },
  { id: 'workload', name: 'Workload', href: '/workload', icon: Users },
  { id: 'files', name: 'Files', href: '/files', icon: Folder },
  { id: 'timesheet', name: 'Timesheet', href: '/timesheet', icon: Timer },
  { id: 'pipeline', name: 'Pipeline', href: '/pipeline', icon: SquareKanban },
  { id: 'documents', name: 'Documents', href: '/documents', icon: File },
  { id: 'goals', name: 'Goals', href: '/goals', icon: Target },
  { id: 'settings', name: 'Settings', href: '/settings', icon: Settings },
];
// Note: defaultProjectTabs uses English names at module level; the layout component
// maps these to translated names via the tabs lookup below.

function SortableTab({ id, children }: { id: string; children: React.ReactNode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const projectId = params.projectId as string;

  // Translated tab names (derived at render time so they respond to locale changes)
  const translatedTabs: ProjectTab[] = [
    { id: 'tasks', name: t.projects.projectLayout.tabs.tasks, href: '/tasks', icon: SquareCheck },
    { id: 'gantt', name: t.projects.projectLayout.tabs.gantt, href: '/gantt', icon: GanttChart },
    { id: 'table', name: t.projects.projectLayout.tabs.sheets, href: '/table', icon: Table2 },
    { id: 'whiteboard', name: t.projects.projectLayout.tabs.whiteboard, href: '/whiteboard', icon: SquareDashedMousePointer },
    { id: 'workload', name: t.projects.projectLayout.tabs.workload, href: '/workload', icon: Users },
    { id: 'files', name: t.projects.projectLayout.tabs.files, href: '/files', icon: Folder },
    { id: 'timesheet', name: t.projects.projectLayout.tabs.timesheet, href: '/timesheet', icon: Timer },
    { id: 'pipeline', name: t.projects.projectLayout.tabs.pipeline, href: '/pipeline', icon: SquareKanban },
    { id: 'documents', name: t.projects.projectLayout.tabs.documents, href: '/documents', icon: File },
    { id: 'goals', name: t.projects.projectLayout.tabs.goals, href: '/goals', icon: Target },
    { id: 'settings', name: t.projects.projectLayout.tabs.settings, href: '/settings', icon: Settings },
  ];

  // Load project name from localStorage
  const [projectName, setProjectName] = React.useState<string>('');
  const [tabs, setTabs] = React.useState<ProjectTab[]>(() => translatedTabs);
  const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);

  // Expandable right-side chat panel — pixel width preference persists across
  // tab switches, page reloads, and projects.
  const CHAT_OPEN_KEY = 'project-chat-panel-open';
  const CHAT_SIZE_KEY = 'project-chat-panel-width';
  const DEFAULT_CHAT_WIDTH = 479;
  const MIN_CHAT_WIDTH = 320;
  const MAX_CHAT_WIDTH = 900;
  const [chatOpen, setChatOpen] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const raw = window.localStorage.getItem(CHAT_OPEN_KEY);
    if (raw === null) return true;
    return raw === 'true';
  });
  const [chatWidth, setChatWidth] = React.useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_CHAT_WIDTH;
    const raw = window.localStorage.getItem(CHAT_SIZE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= MIN_CHAT_WIDTH && parsed <= MAX_CHAT_WIDTH
      ? parsed
      : DEFAULT_CHAT_WIDTH;
  });
  // When any object panel (task, customer, contact, …) is open the project
  // chat hides so they don't fight for screen space. We read the stack
  // directly rather than subscribing to a window event — same source of
  // truth the host renders from.
  const objectPanelStack = useObjectPanelStack();
  const taskPanelOpen = objectPanelStack.length > 0;

  const chatVisible = chatOpen && !taskPanelOpen;

  // Disable animations until the user toggles the chat for the first time.
  // Flipping this via an effect (rAF/setTimeout) would re-add `animate-in` to
  // the already-mounted panel one frame after page load and re-trigger the
  // slide-in animation, which is exactly the flash we saw. Instead we flip
  // it inside the toggle handler — panel mounts fresh on the first open, so
  // animate-in plays cleanly at that moment.
  const [shouldAnimateChat, setShouldAnimateChat] = React.useState(false);

  React.useEffect(() => {
    window.localStorage.setItem(CHAT_OPEN_KEY, chatOpen ? 'true' : 'false');
  }, [chatOpen]);
  React.useEffect(() => {
    window.localStorage.setItem(CHAT_SIZE_KEY, String(chatWidth));
  }, [chatWidth]);

  // Drag-to-resize on the panel's left edge — mirrors the agent panel UX.
  const dragRef = React.useRef(false);
  const handleResizeMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
  React.useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const next = Math.max(
        MIN_CHAT_WIDTH,
        Math.min(MAX_CHAT_WIDTH, window.innerWidth - e.clientX),
      );
      setChatWidth(next);
    };
    const onMouseUp = () => {
      if (!dragRef.current) return;
      dragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const toggleChat = React.useCallback(() => {
    setShouldAnimateChat(true);
    setChatOpen((v) => !v);
  }, []);
  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [tabToDelete, setTabToDelete] = React.useState<{ index: number; name: string } | null>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setTabs((prev) => {
        const oldIndex = prev.findIndex((t) => t.id === active.id);
        const newIndex = prev.findIndex((t) => t.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  };

  // Get tabs that are not currently visible
  const hiddenTabs = translatedTabs.filter(
    (defaultTab) => !tabs.some((tab) => tab.id === defaultTab.id)
  );

  const handleMoveLeft = (index: number) => {
    if (index <= 0) return;
    const newTabs = [...tabs];
    [newTabs[index - 1], newTabs[index]] = [newTabs[index], newTabs[index - 1]];
    setTabs(newTabs);
  };

  const handleMoveRight = (index: number) => {
    if (index >= tabs.length - 1) return;
    const newTabs = [...tabs];
    [newTabs[index], newTabs[index + 1]] = [newTabs[index + 1], newTabs[index]];
    setTabs(newTabs);
  };

  const confirmDelete = (index: number, name: string) => {
    if (tabs.length <= 1) return;
    setTabToDelete({ index, name });
    setShowDeleteDialog(true);
  };

  const handleDelete = async (index: number) => {
    if (tabs.length <= 1) return;
    const deletedTab = tabs[index];
    const newTabs = tabs.filter((_, i) => i !== index);
    setTabs(newTabs);

    // If deleting the active tab, redirect to another tab
    if (deletedTab.id === activeTab) {
      const newActiveIndex = Math.min(index, newTabs.length - 1);
      const newActiveTab = newTabs[newActiveIndex];
      router.push(`/weldflow/project/${projectId}${newActiveTab.href}`);
    }

    // NOTE: removing a tab hides the page; it does NOT delete the data behind it.
    //
    // This used to DELETE one of eight `/weldflow/:projectId/*` bulk endpoints
    // ("wipe every task / file / message in this project"). api-worker mounts no
    // `/weldflow` routes at all, so each call 404'd and a bare catch swallowed it:
    // the data has always survived tab removal. The dead request is dropped rather
    // than repointed — it kept the retiring api-worker client alive for a call
    // that could only fail.
    //
    // TODO(weldflow-bulk-delete): if tab removal should really wipe the tab's
    // data, that needs bulk-by-project endpoints on app-api — it exposes only
    // per-record deletes (`/tasks/:id`, `/whiteboards/:id`, `/project-files/:id`),
    // and fanning out N deletes from the browser is not a port of this behaviour.
    // Note this is a destructive, irreversible action that has never actually run
    // in production, so switching it on is a product decision, not a cleanup.
  };

  const handleAddTab = (tabId: string) => {
    const tabToAdd = translatedTabs.find((tab) => tab.id === tabId);
    if (tabToAdd) {
      setTabs([...tabs, tabToAdd]);
    }
  };

  const loadProjectName = React.useCallback(async () => {
    const result = await projectsApi.get(projectId);
    if (result.success && result.data) {
      setProjectName(result.data.name);
    }
  }, [projectId]);

  React.useEffect(() => {
    loadProjectName();
  }, [loadProjectName]);


  // Update project name instantly when renamed from sidebar
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id === projectId) {
        setProjectName(detail.name);
      }
    };
    window.addEventListener('project:renamed', handler);
    return () => window.removeEventListener('project:renamed', handler);
  }, [projectId]);

  // Determine active tab based on pathname
  const getActiveTab = () => {
    const basePath = `/weldflow/project/${projectId}`;
    if (pathname === basePath) return 'tasks';

    const segment = pathname.replace(basePath, '').split('/')[1];
    return segment || 'tasks';
  };

  const activeTab = getActiveTab();

  // Build PageTab array with hrefs
  const pageTabs: PageTab[] = tabs.map((tab) => ({
    id: tab.id,
    label: tab.name,
    icon: tab.icon,
    href: `/weldflow/project/${projectId}${tab.href}`,
  }));

  return (
    <ProjectPermissionProvider projectId={projectId}>
    <div className="flex flex-col h-full">
      {/* Project Header */}
      <div className="bg-background sticky top-0 z-10 group/header pt-[6px]">
        <div className="mb-3">
          <div className="-mt-2">
            {projectName ? (
              <h1 className="text-xl md:text-2xl font-semibold truncate">{projectName}</h1>
            ) : (
              <div className="h-7 md:h-8 w-40 bg-muted/50 rounded animate-pulse" />
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="-mx-3 md:-mx-4 relative group">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
              <PageTabs
                tabs={pageTabs}
                activeTab={activeTab}
                linkComponent={Link}
                innerClassName="pl-3 md:pl-4 pr-2"
                renderTabWrapper={(tab, index, tabElement) => (
                  <SortableTab id={tab.id}>
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        {tabElement}
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuItem
                          onClick={() => handleMoveLeft(index)}
                          disabled={index === 0}
                        >
                          <ArrowLeft className="mr-0.5 h-4 w-4" />
                          {t.projects.projectLayout.moveLeft}
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() => handleMoveRight(index)}
                          disabled={index === tabs.length - 1}
                        >
                          <ArrowRight className="mr-0.5 h-4 w-4" />
                          {t.projects.projectLayout.moveRight}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          onClick={() => confirmDelete(index, tabs[index].name)}
                          disabled={tabs.length <= 1}
                          className="focus:!text-red-600 focus:!bg-red-100 dark:focus:!bg-red-950/50 focus:[&_svg]:!text-red-600"
                        >
                          <EyeOff className="mr-0.5 h-4 w-4" />
                          {t.projects.projectLayout.hidePage}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </SortableTab>
                )}
              >
                {/* Plus Icon Button - Only visible when there are hidden tabs */}
                {hiddenTabs.length > 0 && (
                  <DropdownMenu onOpenChange={setIsDropdownOpen}>
                    <div className={cn(
                      "relative pb-2 flex items-center flex-shrink-0 transition-opacity ml-1",
                      isDropdownOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-56">
                        <DropdownMenuLabel>{t.projects.projectLayout.addPage}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {hiddenTabs.map((tab) => {
                          const Icon = tab.icon;
                          return (
                            <DropdownMenuItem key={tab.id} onClick={() => handleAddTab(tab.id)}>
                              <Icon className="mr-0.5 h-4 w-4" />
                              <span>{tab.name}</span>
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </div>
                  </DropdownMenu>
                )}
                {!taskPanelOpen && (
                  <div className="ml-auto pb-2 flex items-center flex-shrink-0 pr-2 md:pr-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={toggleChat}
                      aria-label={chatVisible ? t.projects.projectLayout.closeProjectChat : t.projects.projectLayout.openProjectChat}
                      title={chatVisible ? t.projects.projectLayout.closeProjectChat : t.projects.projectLayout.openProjectChat}
                      className="h-7 w-7 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                    >
                      {chatVisible ? (
                        <PanelLeftOpen className="h-4 w-4" />
                      ) : (
                        <PanelRightOpen className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                )}
              </PageTabs>
            </SortableContext>
            <DragOverlay>
              {activeId ? (() => {
                const draggedTab = tabs.find((t) => t.id === activeId);
                if (!draggedTab) return null;
                const Icon = draggedTab.icon;
                return (
                  <div className="relative pb-2 flex items-center flex-shrink-0 cursor-grabbing">
                    <span className="flex items-center gap-2 text-sm font-medium px-2 py-1 rounded-md bg-background shadow-md border text-foreground">
                      <Icon className="h-4 w-4" />
                      {draggedTab.name}
                    </span>
                  </div>
                );
              })() : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>

      {/*
       * Content area + chat panel.
       *
       * Why this exact structure:
       *   1. The panel is ALWAYS mounted (never gated by a JS conditional).
       *      In the previous version we did `{chatVisible && <div … animate-in …>`
       *      which forced React to mount the entire `ProjectChatPanel` tree
       *      (`EntityChat`, `useProjectMembers`, channel `useQuery`, message
       *      list) on every open. That commit work pushed past one frame,
       *      so the `animate-in` keyframe and the content `transition-[width]`
       *      both started late, gave back jagged frames, and felt out of sync —
       *      that was the "buggy second open".
       *   2. Open/close is signalled with `data-state="open|closed"`. Tailwind
       *      variants (`data-[state=open]:…`) toggle the agent-panel keyframe
       *      classes (`animate-in slide-in-from-right fade-in-50 duration-200`)
       *      and the symmetric exit (`animate-out slide-out-to-right
       *      fade-out-50 duration-200`). The `animation-name` property changes
       *      from `none` to `enter`/`exit`, which re-fires the keyframe each
       *      toggle — same visual as the agent panel, no React remount.
       *   3. When closed we apply `pointer-events-none` so the off-screen panel
       *      can't capture clicks. We DON'T use `display:none` — `animate-out`
       *      can't run on a hidden element and we'd be back to instant pop.
       *   4. The content area uses `transition-[width] duration-200` with
       *      `style.width` swapping between `calc(100% - chatWidth)` (open)
       *      and `100%` (closed). This is byte-identical to the agent panel's
       *      content pattern in `chat-layout-client.tsx:214`.
       *   5. `shouldAnimateChat` is flipped on the first user toggle so the
       *      initial paint never animates.
       */}
      <div className="relative flex-1 min-h-0 -mx-3 md:-mx-4 overflow-hidden">
        <div
          data-module-content
          className={cn(
            'h-full overflow-hidden',
            shouldAnimateChat && 'transition-[width] duration-[197ms]',
          )}
          style={{ width: chatVisible ? `calc(100% - ${chatWidth}px)` : '100%' }}
        >
          <div
            className={cn(
              'h-full overflow-auto flex flex-col min-h-0',
              activeTab === 'whiteboard' ? '' :
                activeTab === 'documents' || activeTab === 'goals' || activeTab === 'table' || activeTab === 'gantt' || activeTab === 'workload' || activeTab === 'members' || activeTab === 'pipeline' || activeTab === 'timesheet' || activeTab === 'tasks' || activeTab === 'settings' ? '' : 'pt-4'
            )}
          >
            {children}
          </div>
        </div>
        {/*
         * Mount gate: render the panel when the user *wants* it open
         * (`chatOpen`) OR they've toggled it at least once this session
         * (`shouldAnimateChat`). We deliberately don't gate on
         * `chatVisible` because task-detail clicks flip it without a user
         * intent to close the chat — gating on chatVisible would unmount
         * the message list and blow away the channel query on every task
         * click.
         *
         *   - Fresh load, chatOpen=false → not rendered. The previous
         *     implementation left the panel mounted with `translate-x-full
         *     opacity-50 pointer-events-none`; under the right stacking
         *     conditions the off-screen element still left the page in a
         *     faded / unclickable state after a close → refresh cycle.
         *   - Fresh load, chatOpen=true → rendered immediately, no
         *     animation (shouldAnimateChat=false).
         *   - User close → chatOpen=false but shouldAnimateChat=true, so
         *     the panel stays mounted and its React subtree survives.
         */}
        {(chatOpen || shouldAnimateChat) && (
          <div
            data-state={chatVisible ? 'open' : 'closed'}
            aria-hidden={!chatVisible}
            className={cn(
              'absolute right-0 top-0 bottom-0 z-10 bg-background border-l flex',
              'data-[state=closed]:translate-x-full data-[state=closed]:opacity-50 data-[state=closed]:pointer-events-none',
              shouldAnimateChat &&
                'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:fade-in-50 data-[state=open]:duration-[197ms]',
            )}
            style={{ width: chatWidth }}
          >
            {/* Resize handle on the left edge — drag to resize */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group"
              onMouseDown={handleResizeMouseDown}
            >
              <div className="absolute inset-y-0 -left-1 -right-1 flex items-center justify-center">
                <div className="h-6 w-1 rounded-full bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-accent transition-colors" />
              </div>
            </div>
            <div className="flex-1 min-w-0 h-full">
              <ProjectChatPanel projectId={projectId} projectName={projectName} />
            </div>
          </div>
        )}
      </div>

      {/* Hide Page Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.projectLayout.hidePageTitle}</DialogTitle>
            <DialogDescription>
              {t.projects.projectLayout.hidePageDescription.replace('{name}', tabToDelete?.name ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              {t.projects.projectLayout.cancel}
            </Button>
            <Button
              onClick={async () => {
                if (tabToDelete) {
                  await handleDelete(tabToDelete.index);
                  setTabToDelete(null);
                }
                setShowDeleteDialog(false);
              }}
            >
              {t.projects.projectLayout.hide}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
    </ProjectPermissionProvider>
  );
}
