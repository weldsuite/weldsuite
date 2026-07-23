
import * as React from "react"
import { useEffect, useCallback } from "react"
import { Tooltip, TooltipTrigger, TooltipContent } from '@weldsuite/ui/components/tooltip'
import { useRouter, Link, usePathname } from '@/lib/router';
import { useClerk } from "@clerk/clerk-react"
import { useTheme } from '@/hooks/use-theme'
import { useSettings } from '@/providers/settings-provider'
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  DragOverlay,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
} from "@weldsuite/ui/components/sidebar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@weldsuite/ui/components/collapsible"
import { LucideIcon, Plus, MoreVertical, ChevronDown, ChevronLeft, ChevronRight, Trash2, Copy, Download, Upload, Palette, ImageIcon, SquarePen, Building, User, Users, Briefcase, Target, Layers, Star, Heart, Zap, Globe, Mail, Phone, Calendar, FileText, FolderOpen, ShoppingBag, CreditCard, Truck, Package, Tag, Flag, ArrowUp, ArrowDown, Video } from "lucide-react"
import { cn } from "@/lib/utils"
import { SidebarUserMenu, type UserInfo, type Workspace } from "@weldsuite/ui/components/sidebar-user-menu"
import { usePresenceMaybe } from "@/contexts/presence-context"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@weldsuite/ui/components/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@weldsuite/ui/components/context-menu"
import { Button } from "@weldsuite/ui/components/button"
import { useMobileNavActions } from "@/contexts/mobile-nav-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { InviteMemberButton } from "@/components/invite-member-button"
import { UpgradeButton } from "@/components/upgrade-button"
import { useFeatureFlag } from "@/hooks/queries/use-feature-flags-queries"
import { ResourceUsage } from "@/components/resource-usage"
import { OnboardingChecklist } from "@/components/layout/onboarding-checklist-group"
import { CalendarLogoIcon } from "@/components/calendar-logo-icon"

export { type UserInfo, type Workspace }

interface ItemAction {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
}

export interface MenuItemProps {
  title: string;
  href: string;
  icon: LucideIcon | React.ComponentType<{ className?: string }>;
  actions?: ItemAction[];
  /** Override pathname-based active matching (e.g. for items disambiguated by query string) */
  isActive?: boolean;
  /** Show title in bold (e.g. for unread channels) */
  bold?: boolean;
  /** Badge text shown next to the title (e.g. "@2" for mention count) */
  badge?: string;
  subItems?: MenuItemProps[];
  onAddSubItem?: () => void;
  /** Use colored square background for icon */
  iconStyle?: 'default' | 'colored-square';
  /** Background color for colored-square style (e.g., 'bg-orange-500', 'bg-blue-500') */
  iconColor?: string;
  /** Show green indicator for active call */
  activeCall?: boolean;
  /** Type of active call (voice or video) */
  activeCallType?: 'voice' | 'video';
  /** ID of the active call (for joining) */
  activeCallId?: string;
  /** Callback when the active call icon is clicked */
  onJoinCall?: () => void;
  /**
   * Optional permission key (format: `object:action`, e.g. `leads:read`).
   * When set, the item is only shown to users who have this permission.
   * Items without a permission field always show.
   */
  permission?: string;
  /** Unique ID for the item (used for context menu actions) */
  id?: string;
  /** Handler for deleting the item */
  onDelete?: () => void;
  /** Handler for duplicating the item */
  onDuplicate?: () => void;
  /** Handler for changing the icon color */
  onChangeColor?: (color: string) => void;
  /** Handler for changing the icon */
  onChangeIcon?: (icon: LucideIcon) => void;
  /** Handler for importing data */
  onImport?: () => void;
  /** Handler for exporting data */
  onExport?: () => void;
  /** Handler for renaming the item */
  onRename?: () => void;
  /** Handler for moving the item up */
  onMoveUp?: () => void;
  /** Handler for moving the item down */
  onMoveDown?: () => void;
}

export interface MenuGroupProps {
  group: string;
  items: MenuItemProps[];
  customContent?: React.ReactNode;
  onAdd?: () => void;
  customAddButton?: React.ReactNode;
  /** Enable drag-and-drop reordering for items in this group */
  draggable?: boolean;
  /** Called when items are reordered via drag-and-drop */
  onReorder?: (items: MenuItemProps[]) => void;
  /** Context menu items for right-clicking the group label */
  groupContextMenu?: { label: string; onClick: () => void; destructive?: boolean; icon?: React.ComponentType<{ className?: string }> }[];
  /** When true, items are hidden under the group label (still clickable to expand). */
  collapsed?: boolean;
  /** Called when the user clicks the group label / chevron to toggle collapse. */
  onToggleCollapse?: () => void;
  /** Stable identifier for cross-group drag-and-drop. Required when accepting cross-group drops. */
  groupKey?: string;
  /** Called when an item is dragged from another group into this one. */
  onCrossGroupDrop?: (itemId: string, fromGroupKey: string, toGroupKey: string) => void;
  /** Render this group even when it has no items (e.g. WeldChat sections that act as drop targets). */
  keepWhenEmpty?: boolean;
  /** When true, render items without a group header label (collapse controls are also suppressed). */
  hideLabel?: boolean;
  /** Override the label shown on the empty-state "+ Add ..." dashed button. Defaults to a singularized form of `group`. */
  addLabel?: string;
}

export interface EmailAccount {
  id: string;
  email: string;
  displayName?: string;
}

export interface AppLogo {
  /** Logo icon (collapsed state) - light theme */
  iconLight: string;
  /** Logo icon (collapsed state) - dark theme */
  iconDark: string;
  /** Logo with text (expanded state) - light theme (optional, falls back to icon + app name) */
  textLight?: string;
  /** Logo with text (expanded state) - dark theme (optional, falls back to icon + app name) */
  textDark?: string;
  /** Optional class override for the text logo size */
  textClassName?: string;
  /** Optional class override for the icon logo size */
  iconClassName?: string;
}

// Available colors for colored-square icons
export const coloredSquareColors = [
  { value: 'bg-red-500', label: 'Red' },
  { value: 'bg-pink-500', label: 'Pink' },
  { value: 'bg-purple-500', label: 'Purple' },
  { value: 'bg-indigo-500', label: 'Indigo' },
  { value: 'bg-blue-500', label: 'Blue' },
  { value: 'bg-cyan-500', label: 'Cyan' },
  { value: 'bg-teal-500', label: 'Teal' },
  { value: 'bg-green-500', label: 'Green' },
  { value: 'bg-yellow-500', label: 'Yellow' },
  { value: 'bg-orange-500', label: 'Orange' },
  { value: 'bg-amber-500', label: 'Amber' },
  { value: 'bg-gray-500', label: 'Gray' },
];

// Available icons for colored-square items
export const coloredSquareIcons: { value: LucideIcon; label: string }[] = [
  { value: Building, label: 'Building' },
  { value: User, label: 'User' },
  { value: Users, label: 'Users' },
  { value: Briefcase, label: 'Briefcase' },
  { value: Target, label: 'Target' },
  { value: Layers, label: 'Layers' },
  { value: Star, label: 'Star' },
  { value: Heart, label: 'Heart' },
  { value: Zap, label: 'Zap' },
  { value: Globe, label: 'Globe' },
  { value: Mail, label: 'Mail' },
  { value: Phone, label: 'Phone' },
  { value: Calendar, label: 'Calendar' },
  { value: FileText, label: 'File' },
  { value: FolderOpen, label: 'Folder' },
  { value: ShoppingBag, label: 'Shopping' },
  { value: CreditCard, label: 'Card' },
  { value: Truck, label: 'Truck' },
  { value: Package, label: 'Package' },
  { value: Tag, label: 'Tag' },
  { value: Flag, label: 'Flag' },
];

export interface AppSidebarLayoutProps extends React.ComponentProps<typeof Sidebar> {
  appName: string;
  appIcon: LucideIcon;
  appLogo?: AppLogo;
  menuItems: MenuGroupProps[];
  workspaceSwitcher?: React.ReactNode;
  footer?: React.ReactNode;
  // User menu props
  user?: UserInfo;
  currentWorkspace?: Workspace | null;
  workspaces?: Workspace[];
  onWorkspaceSwitch?: (workspaceId: string) => void;
  onWorkspaceCreate?: () => void;
  // Email account props (for mail module)
  currentEmailAccount?: EmailAccount | null;
  emailAccounts?: EmailAccount[];
  onEmailAccountSwitch?: (accountId: string) => void;
  onEmailAccountAdd?: () => void;
  defaultEmailAccountId?: string | null;
  onSetDefaultEmailAccount?: (accountId: string | null) => void;
  setDefaultLabel?: string;
  defaultLabel?: string;
  // Back button (for settings page)
  showBackButton?: boolean;
  onBack?: () => void;
  /**
   * When true (default) the sidebar's scrollbar is visually hidden while the
   * content still scrolls. Set to false to show the native scrollbar (e.g.
   * WeldChat, where long channel lists benefit from a visible scrollbar).
   */
  hideScrollbar?: boolean;
}

// Sortable wrapper for sidebar menu items (drag-and-drop reordering)
function SortableSidebarItem({ id, children }: { id: string; children: React.ReactNode }) {
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
    opacity: isDragging ? 0.4 : 1,
    position: 'relative' as const,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

export function AppSidebarLayout({
  appName,
  appIcon: AppIcon,
  appLogo,
  menuItems,
  workspaceSwitcher,
  footer,
  user,
  currentWorkspace,
  workspaces,
  onWorkspaceSwitch,
  onWorkspaceCreate,
  currentEmailAccount,
  emailAccounts,
  onEmailAccountSwitch,
  onEmailAccountAdd,
  defaultEmailAccountId,
  onSetDefaultEmailAccount,
  setDefaultLabel,
  defaultLabel,
  showBackButton,
  onBack,
  hideScrollbar = true,
  ...props
}: AppSidebarLayoutProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { state } = useSidebar()
  const { openSettings } = useSettings()
  const isMobile = useIsMobile()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  const { signOut } = useClerk()
  const presence = usePresenceMaybe()

  // Sidebar Upgrade button is gated behind a Cloudflare Flagship feature flag.
  // Hidden by default — shown only to segments the flag targets.
  const showUpgradeButton = useFeatureFlag("upgrade-button")

  // Track whether the sidebar content actually overflows (i.e. can scroll).
  // Only relevant when the scrollbar is visible (hideScrollbar=false, e.g.
  // WeldChat): when scrollable we drop the groups' 8px right padding to 0 so
  // the content sits flush against the scrollbar; otherwise it stays at 8px.
  const scrollContentRef = React.useRef<HTMLDivElement | null>(null)
  const [isScrollable, setIsScrollable] = React.useState(false)
  React.useEffect(() => {
    if (hideScrollbar) {
      setIsScrollable(false)
      return
    }
    const el = scrollContentRef.current
    if (!el) return
    const measure = () => {
      setIsScrollable(el.scrollHeight > el.clientHeight)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const mo = new MutationObserver(measure)
    mo.observe(el, { childList: true, subtree: true, attributes: true })
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [hideScrollbar, menuItems, state])

  // Drag-and-drop sensors for sidebar reordering
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent, group: MenuGroupProps) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !group.onReorder) return;

    const oldIndex = group.items.findIndex(item => item.href === active.id);
    const newIndex = group.items.findIndex(item => item.href === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newItems = arrayMove(group.items, oldIndex, newIndex);
    group.onReorder(newItems);
  }, []);

  /**
   * Cross-group drag-end handler. Activated when any group has both `groupKey` and
   * `onCrossGroupDrop` defined. Handles within-group reorder OR cross-group move.
   */
  const handleGlobalDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    const fromGroup = menuItems.find((g) => g.items.some((i) => i.href === activeId));
    if (!fromGroup) return;

    const toGroup = menuItems.find(
      (g) =>
        g.items.some((i) => i.href === overId) ||
        (g.groupKey && overId === `dropzone:${g.groupKey}`),
    );
    if (!toGroup) return;

    if (fromGroup === toGroup) {
      if (!fromGroup.onReorder) return;
      const oldIdx = fromGroup.items.findIndex((i) => i.href === activeId);
      const newIdx = fromGroup.items.findIndex((i) => i.href === overId);
      if (oldIdx === -1 || newIdx === -1) return;
      fromGroup.onReorder(arrayMove(fromGroup.items, oldIdx, newIdx));
      return;
    }

    if (!fromGroup.onCrossGroupDrop || !fromGroup.groupKey || !toGroup.groupKey) return;
    const draggedItem = fromGroup.items.find((i) => i.href === activeId);
    if (!draggedItem?.id) return;
    fromGroup.onCrossGroupDrop(draggedItem.id, fromGroup.groupKey, toGroup.groupKey);
  }, [menuItems]);

  const crossGroupEnabled = menuItems.some((g) => g.groupKey && g.onCrossGroupDrop);

  // Get actions only - this hook is stable and won't cause re-renders
  const mobileNavActions = useMobileNavActions()

  // Register module info with mobile nav context on mount
  useEffect(() => {
    mobileNavActions.setModuleInfo({ name: appName, icon: AppIcon, logo: appLogo, hideIconOnMobile: showBackButton })

    // Cleanup on unmount
    return () => {
      mobileNavActions.setModuleMenuItems([])
      mobileNavActions.setModuleInfo(null)
    }
  }, [appName, AppIcon, appLogo, mobileNavActions])

  // Register menu items with mobile nav context - runs whenever menuItems change
  useEffect(() => {
    mobileNavActions.setModuleMenuItems(menuItems)
  }, [menuItems, mobileNavActions])

  // Standardized handlers
  const handleSignOut = () => {
    signOut({ redirectUrl: '/auth/login' });
  };

  const handleSettings = () => {
    openSettings();
  };

  // On mobile, render a minimal hidden sidebar to maintain context for customContent components
  // The actual mobile navigation is handled by MobileSidebar
  // NOTE: We don't return early here to avoid React hooks order issues during client-side navigation
  // Instead we conditionally render different content within the same component tree

  return (
    <Sidebar
      collapsible={isMobile ? "none" : "offcanvas"}
      className={cn(
        isMobile ? "hidden" : "left-16",
        // Turn the module sidebar into a "panel" that matches the shell
        // chrome: inset it from the top/bottom, sit flush against the rail on
        // its left, and keep its right edge flush so the content card attaches
        // directly to it. The inner surface gets the panel tone and a
        // left-rounded card edge (the rail's chrome shows in the rounded
        // notch); no border — the panel/content color change is the seam.
        !isMobile &&
          "group-data-[side=left]:!border-r-0 md:py-2 [&_[data-slot=sidebar-inner]]:!bg-[var(--shell-panel)] [&_[data-slot=sidebar-inner]]:rounded-l-xl",
      )}
      {...props}
    >
      <SidebarHeader className="pb-2.5">
        <div className="flex flex-col gap-1 px-2 pt-2 pb-0">
          <div className={cn(
            "flex items-center gap-2",
            state === "collapsed" ? "justify-center px-0" : "px-2"
          )}>
            {showBackButton ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 -ml-2"
                  onClick={onBack}
                >
                  <ChevronLeft className="h-6 w-6" />
                </Button>
                {state === "expanded" && (
                  <span className="text-lg font-semibold -ml-1">{appName}</span>
                )}
              </>
            ) : appLogo ? (
              // Icon + app name lockup — a consistent, lightweight treatment
              // that suits the gray panel far better than the full-colour
              // branded wordmarks. Collapsed state shows just the icon.
              <>
                {appLogo.iconLight?.includes('/weldcalendar/') ? (
                  <CalendarLogoIcon className={appLogo.iconClassName || "h-5 w-5 shrink-0"} />
                ) : (
                  <img
                    src={isDark ? appLogo.iconDark : appLogo.iconLight}
                    alt={appName}
                    width={64}
                    height={64}
                    className={appLogo.iconClassName || "h-5 w-5 shrink-0"}
                  />
                )}
                {state === "expanded" && (
                  <span className="text-lg font-semibold">{appName}</span>
                )}
              </>
            ) : (
              <>
                <AppIcon className="h-6 w-6 shrink-0" />
                {state === "expanded" && (
                  <span className="text-lg font-semibold">{appName}</span>
                )}
              </>
            )}
          </div>
          {workspaceSwitcher && state === "expanded" && (
            <div className="px-2">
              {workspaceSwitcher}
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent
        ref={scrollContentRef}
        className={cn(
          "overflow-x-hidden",
          hideScrollbar
            ? "[&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
            // Hover-only scrollbar (WeldChat). See `.sidebar-hover-scrollbar`
            // in globals.css — invisible by default, fades in on hover, no
            // gutter reserved so content uses the full sidebar width.
            : "sidebar-hover-scrollbar",
          isScrollable && "[&_[data-sidebar=group]]:pr-0"
        )}
      >
        <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleGlobalDragEnd}>
        {menuItems.map((group, groupIndex) => {
          // Flatten all menu items across all groups for matching logic
          const allMenuItems = menuItems.flatMap(g => g.items);

          return (
          <SidebarGroup key={group.groupKey ?? `${group.group}:${groupIndex}`}>
            {group.group && !group.hideLabel && (
              group.groupContextMenu && group.groupContextMenu.length > 0 ? (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div className="group/label relative flex items-center rounded-md px-1 py-0 -mx-1 transition-colors hover:bg-sidebar-accent">
                      <SidebarGroupLabel
                        className={cn('flex items-center gap-1 flex-1', group.onToggleCollapse && 'cursor-pointer select-none')}
                        onClick={group.onToggleCollapse}
                      >
                        <span>{group.group}</span>
                        {group.onToggleCollapse && (
                          <span
                            className="inline-flex items-center justify-center w-4 h-4 rounded text-muted-foreground"
                            aria-label={group.collapsed ? 'Expand group' : 'Collapse group'}
                          >
                            {group.collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          </span>
                        )}
                      </SidebarGroupLabel>
                      <div className="flex items-center gap-0.5">
                        {group.customAddButton}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="opacity-0 group-hover/label:opacity-100 data-[state=open]:opacity-100 transition-opacity flex items-center justify-center w-5 h-5 rounded-[6px] hover:bg-black/[0.05] dark:hover:bg-black/20 data-[state=open]:bg-black/[0.05] dark:data-[state=open]:bg-black/20 text-muted-foreground outline-none ring-0 focus:ring-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            {group.groupContextMenu.map((item, i) => {
                              const Icon = item.icon;
                              return (
                                <DropdownMenuItem
                                  key={i}
                                  onClick={item.onClick}
                                  className={item.destructive ? 'text-destructive focus:text-destructive focus:bg-destructive/10 hover:bg-destructive/10' : ''}
                                >
                                  {Icon && <Icon className={`h-4 w-4 mr-0.5 ${item.destructive ? 'text-destructive' : ''}`} />}
                                  {item.label}
                                </DropdownMenuItem>
                              );
                            })}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {group.groupContextMenu.map((item, i) => {
                      const Icon = item.icon;
                      return (
                        <ContextMenuItem
                          key={i}
                          onClick={item.onClick}
                          className={item.destructive ? 'text-destructive focus:text-destructive focus:bg-destructive/10 hover:bg-destructive/10' : ''}
                        >
                          {Icon && <Icon className={`h-4 w-4 mr-0.5 ${item.destructive ? 'text-destructive' : ''}`} />}
                          {item.label}
                        </ContextMenuItem>
                      );
                    })}
                  </ContextMenuContent>
                </ContextMenu>
              ) : (
              <div className="group/label relative flex items-center rounded-md px-1 py-0 -mx-1 transition-colors hover:bg-sidebar-accent">
                {group.onToggleCollapse && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={group.onToggleCollapse}
                    className="flex items-center justify-center w-4 h-4 rounded text-muted-foreground hover:text-foreground"
                    aria-label={group.collapsed ? 'Expand group' : 'Collapse group'}
                  >
                    {group.collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </Button>
                )}
                <SidebarGroupLabel
                  className={cn('flex-1', group.onToggleCollapse && 'cursor-pointer select-none')}
                  onClick={group.onToggleCollapse}
                >
                  {group.group}
                </SidebarGroupLabel>
                {group.customAddButton ? (
                  group.customAddButton
                ) : group.onAdd ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={group.onAdd}
                    className="opacity-0 group-hover/label:opacity-100 transition-opacity flex items-center justify-center w-5 h-5 rounded-[6px] hover:bg-black/[0.05] dark:hover:bg-black/20"
                    style={{ marginLeft: '-12px' }}
                  >
                    <Plus className="w-4 h-4" />
                    <span className="sr-only">Add {group.group}</span>
                  </Button>
                ) : null}
              </div>
              )
            )}
            <SidebarGroupContent>
              {group.customContent ? (
                group.customContent
              ) : (
                <SidebarMenu>
                  {group.items.length === 0 && group.onAdd && !group.collapsed && (
                    <SidebarMenuItem>
                      <Button
                        variant="ghost"
                        onClick={group.onAdd}
                        className="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground border border-dashed border-gray-300 dark:border-border hover:border-gray-400 dark:hover:border-gray-500 rounded-md transition-colors h-auto"
                      >
                        <Plus className="h-4 w-4" />
                        <span>{group.addLabel ?? `Add ${group.group?.toLowerCase().replace(/s$/, '')}`}</span>
                      </Button>
                    </SidebarMenuItem>
                  )}
                  {(() => {
                    const isDraggable = group.draggable && group.onReorder;
                    const itemsContent = group.items.map((item) => {
                    const Icon = item.icon;
                    // Check if current path is active
                    // Exact match: pathname exactly equals href
                    const isExactMatch = pathname === item.href;

                    // Child route match: pathname starts with href + '/'
                    // But only if no other menu item with a MORE SPECIFIC (longer) path matches
                    // This allows /commerce/products to match /commerce/products/add
                    // But prevents /commerce from matching /commerce/products
                    const isChildRoute = pathname?.startsWith(item.href + '/') &&
                      !allMenuItems.some(otherItem =>
                        otherItem.href !== item.href &&
                        otherItem.href.length > item.href.length && // Only consider more specific routes
                        (pathname === otherItem.href || pathname?.startsWith(otherItem.href + '/'))
                      );

                    const isActive = item.isActive ?? (isExactMatch || isChildRoute);

                    // Check if item has sub-items
                    const hasSubItems = item.subItems && item.subItems.length > 0;

                    // Wrapper for sortable drag-and-drop
                    const MaybeSortable = isDraggable
                      ? ({ children: c }: { children: React.ReactNode }) => <SortableSidebarItem id={item.href}>{c}</SortableSidebarItem>
                      : React.Fragment;

                    if (hasSubItems) {
                      return (
                        <MaybeSortable key={item.href}>
                        <Collapsible defaultOpen className="group/collapsible">
                          <SidebarMenuItem>
                            <div className="group/item flex items-center justify-between rounded-md transition-colors hover:bg-accent py-1">
                              <div className="flex items-center flex-1 min-w-0">
                                <Icon className="h-4 w-4 ml-2 shrink-0" />
                                <span className={cn("ml-2 truncate", item.bold ? "font-semibold text-foreground" : "text-muted-foreground")}>{item.title}</span>
                                {item.badge && <span className={cn("ml-auto text-[11px] font-mono font-medium leading-none text-white bg-red-500 border border-red-600 h-[18px] min-w-[18px] flex items-center justify-center rounded-[6px]", /^[1-9]$/.test(String(item.badge)) ? "indent-[0.5px]" : "indent-[1.5px]")}>{item.badge}</span>}
                              </div>
                              <div className="flex items-center gap-0">
                                {item.actions && item.actions.length > 0 && (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className={cn(
                                          "h-6 w-6 transition-opacity opacity-0 group-hover/item:opacity-100 hover:bg-muted-foreground/20 rounded-sm"
                                        )}
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <MoreVertical className="h-3 w-3" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      {item.actions.map((action, idx) => {
                                        const ActionIcon = action.icon;
                                        const isDelete = action.label.toLowerCase() === 'delete';
                                        return (
                                          <React.Fragment key={idx}>
                                            <DropdownMenuItem
                                              onClick={action.onClick}
                                              className={isDelete ? "text-red-600 focus:text-red-600 focus:bg-red-600/10 hover:bg-red-600/10" : ""}
                                            >
                                              {ActionIcon && <ActionIcon className={cn("mr-0.5 h-4 w-4", isDelete && "text-red-600")} />}
                                              {action.label}
                                            </DropdownMenuItem>
                                            {idx < item.actions!.length - 1 && action.label === 'Rename' && (
                                              <DropdownMenuSeparator />
                                            )}
                                          </React.Fragment>
                                        );
                                      })}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}
                                {item.onAddSubItem && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className={cn(
                                      "h-6 w-6 transition-opacity opacity-0 group-hover/item:opacity-100 hover:bg-muted-foreground/20 rounded-sm"
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      item.onAddSubItem?.();
                                    }}
                                  >
                                    <Plus className="h-3 w-3" />
                                  </Button>
                                )}
                                <CollapsibleTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 mr-1 hover:bg-muted-foreground/20 rounded-sm"
                                  >
                                    <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
                                  </Button>
                                </CollapsibleTrigger>
                              </div>
                            </div>
                            <CollapsibleContent>
                              <SidebarMenuSub>
                                {item.subItems?.map((subItem) => {
                                  const isSubActive = pathname === subItem.href;
                                  return (
                                    <SidebarMenuSubItem key={subItem.href}>
                                      <div
                                        className={cn(
                                          "group/subitem flex items-center justify-between rounded-md transition-colors hover:bg-accent"
                                        )}
                                      >
                                        <SidebarMenuSubButton asChild isActive={isSubActive} className="flex-1 hover:bg-transparent">
                                          <Link href={subItem.href}>
                                            <span>{subItem.title}</span>
                                          </Link>
                                        </SidebarMenuSubButton>
                                        {subItem.actions && subItem.actions.length > 0 && (
                                          <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className={cn(
                                                  "h-6 w-6 mr-1 transition-opacity opacity-0 group-hover/subitem:opacity-100 hover:bg-muted-foreground/20 rounded-sm"
                                                )}
                                                onClick={(e) => e.stopPropagation()}
                                              >
                                                <MoreVertical className="h-3 w-3" />
                                              </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                              {subItem.actions.map((action, idx) => {
                                                const ActionIcon = action.icon;
                                                const isDelete = action.label.toLowerCase() === 'delete';
                                                return (
                                                  <React.Fragment key={idx}>
                                                    <DropdownMenuItem
                                                      onClick={action.onClick}
                                                      className={isDelete ? "text-red-600 focus:text-red-600 focus:bg-red-600/10 hover:bg-red-600/10" : ""}
                                                    >
                                                      {ActionIcon && <ActionIcon className={cn("mr-0.5 h-4 w-4", isDelete && "text-red-600")} />}
                                                      {action.label}
                                                    </DropdownMenuItem>
                                                    {idx < subItem.actions!.length - 1 && action.label === 'Rename' && (
                                                      <DropdownMenuSeparator />
                                                    )}
                                                  </React.Fragment>
                                                );
                                              })}
                                            </DropdownMenuContent>
                                          </DropdownMenu>
                                        )}
                                      </div>
                                    </SidebarMenuSubItem>
                                  );
                                })}
                              </SidebarMenuSub>
                            </CollapsibleContent>
                          </SidebarMenuItem>
                        </Collapsible>
                        </MaybeSortable>
                      );
                    }

                    // Regular item without sub-items
                    const hasContextMenu = item.iconStyle === 'colored-square' && (item.onDelete || item.onDuplicate || item.onChangeColor || item.onChangeIcon || item.onImport || item.onExport || item.onRename);
                    const hasActionsContextMenu = !hasContextMenu && item.actions && item.actions.length > 0;

                    const itemContent = (
                      <div
                        className={cn(
                          "group/item relative flex items-center justify-between rounded-md transition-colors hover:bg-accent",
                          item.activeCall && "bg-[linear-gradient(155deg,transparent_30%,rgb(74_222_128/0.04)_55%,rgb(74_222_128/0.10)_80%,rgb(74_222_128/0.18)_100%)] hover:bg-[linear-gradient(155deg,transparent_25%,rgb(74_222_128/0.06)_55%,rgb(74_222_128/0.14)_80%,rgb(74_222_128/0.22)_100%)]"
                        )}
                      >
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          className={cn(
                            "flex-1 hover:bg-transparent",
                            // Discord-style: shrink the title's available width while
                            // the absolute-positioned dots button is on screen, so a
                            // long channel name gets truncated earlier instead of
                            // being covered. `pr-7` ≈ button (24px) + right offset.
                            // `:has` keeps the padding while the dropdown is open
                            // even after the cursor leaves the row.
                            // SidebarMenuButton's base style includes `padding` in its
                            // `transition-property` list — we override to exclude it so
                            // the truncate snap is instant, not animated.
                            item.actions && item.actions.length > 0 && !item.activeCall &&
                              "transition-[width,height] group-hover/item:pr-7 group-has-[[data-state=open]]/item:pr-7",
                          )}
                        >
                          <Link href={item.href} onClick={() => {
                            if (item.href.startsWith('/settings') && !pathname?.startsWith('/settings')) {
                              sessionStorage.setItem('settings-return-url', pathname || '/');
                            }
                          }}>
                            {item.iconStyle === 'colored-square' ? (
                              <div className={cn(
                                "flex items-center justify-center w-[18px] h-[18px] rounded-[6px]",
                                item.iconColor || "bg-gray-500"
                              )}>
                                <Icon className="h-2.5 w-2.5 text-white" />
                              </div>
                            ) : (
                              <Icon className="h-4 w-4" />
                            )}
                            <span className={cn("truncate min-w-0", item.bold ? "font-semibold text-foreground" : "text-muted-foreground")}>{item.title}</span>
                            {item.activeCall && (
                              <Tooltip delayDuration={1000}>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); item.onJoinCall?.(); }}
                                    className="ml-auto -mr-[2px] text-green-500 hover:bg-green-500/15 p-[5px] rounded-md transition-colors h-auto w-auto"
                                  >
                                    {item.activeCallType === 'video' ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" fill="currentColor" />}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={4}>Join call</TooltipContent>
                              </Tooltip>
                            )}
                            {item.badge && <span className={cn("text-[11px] font-mono font-medium leading-none text-white bg-red-500 border border-red-600 h-[18px] min-w-[18px] flex items-center justify-center rounded-[6px]", !item.activeCall && "ml-auto", /^[1-9]$/.test(String(item.badge)) ? "indent-[0.5px]" : "indent-[1.5px]")}>{item.badge}</span>}
                          </Link>
                        </SidebarMenuButton>
                        {item.actions && item.actions.length > 0 && !item.activeCall && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 transition-opacity opacity-0 group-hover/item:opacity-100 data-[state=open]:opacity-100 hover:bg-muted-foreground/10 rounded-sm z-10"
                                )}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MoreVertical className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {item.actions.map((action, idx) => {
                                const ActionIcon = action.icon;
                                const isDelete = action.label.toLowerCase() === 'delete';
                                return (
                                  <React.Fragment key={idx}>
                                    <DropdownMenuItem
                                      onClick={action.onClick}
                                      className={isDelete ? "text-red-600 focus:text-red-600 focus:bg-red-600/10 hover:bg-red-600/10" : ""}
                                    >
                                      {ActionIcon && <ActionIcon className={cn("mr-0.5 h-4 w-4", isDelete && "text-red-600")} />}
                                      {action.label}
                                    </DropdownMenuItem>
                                    {idx < item.actions!.length - 1 && action.label === 'Rename' && (
                                      <DropdownMenuSeparator />
                                    )}
                                  </React.Fragment>
                                );
                              })}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        {hasContextMenu && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  // Darker patch than the row's hover (`bg-accent`): a translucent
                                  // black overlay reads as a slightly darker version of the same area
                                  // in both light and dark themes (in dark, `bg-accent` alone matched
                                  // the row exactly and showed no contrast).
                                  "absolute right-1 h-6 w-6 transition-opacity opacity-0 group-hover/item:opacity-100 hover:bg-black/[0.05] dark:hover:bg-black/20 rounded-md"
                                )}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MoreVertical className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {item.onRename && (
                                <DropdownMenuItem onClick={item.onRename} className="gap-2">
                                  <SquarePen className="h-4 w-4" />
                                  Rename
                                </DropdownMenuItem>
                              )}
                              {(item.onMoveUp || item.onMoveDown) && (
                                <>
                                  <DropdownMenuSeparator />
                                  {item.onMoveUp && (
                                    <DropdownMenuItem onClick={item.onMoveUp} className="gap-2">
                                      <ArrowUp className="h-4 w-4" />
                                      Move Up
                                    </DropdownMenuItem>
                                  )}
                                  {item.onMoveDown && (
                                    <DropdownMenuItem onClick={item.onMoveDown} className="gap-2">
                                      <ArrowDown className="h-4 w-4" />
                                      Move Down
                                    </DropdownMenuItem>
                                  )}
                                </>
                              )}
                              {item.onRename && (item.onDuplicate || item.onExport || item.onImport) && (
                                <DropdownMenuSeparator />
                              )}
                              {item.onDuplicate && (
                                <DropdownMenuItem onClick={item.onDuplicate} className="gap-2">
                                  <Copy className="h-4 w-4" />
                                  Duplicate
                                </DropdownMenuItem>
                              )}
                              {item.onExport && (
                                <DropdownMenuItem onClick={item.onExport} className="gap-2">
                                  <Download className="h-4 w-4" />
                                  Export
                                </DropdownMenuItem>
                              )}
                              {item.onImport && (
                                <DropdownMenuItem onClick={item.onImport} className="gap-2">
                                  <Upload className="h-4 w-4" />
                                  Import
                                </DropdownMenuItem>
                              )}
                              {(item.onDuplicate || item.onExport || item.onImport || item.onRename) && item.onDelete && (
                                <DropdownMenuSeparator />
                              )}
                              {item.onDelete && (
                                <DropdownMenuItem variant="destructive" onClick={item.onDelete} className="gap-2">
                                  <Trash2 className="h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    );

                    if (hasContextMenu) {
                      return (
                        <MaybeSortable key={item.href}>
                        <SidebarMenuItem>
                          <ContextMenu>
                            <ContextMenuTrigger asChild>
                              {itemContent}
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-56">
                              {item.onRename && (
                                <ContextMenuItem onClick={item.onRename} className="gap-2">
                                  <SquarePen className="h-4 w-4" />
                                  Rename
                                </ContextMenuItem>
                              )}
                              {(item.onMoveUp || item.onMoveDown) && (
                                <>
                                  <ContextMenuSeparator />
                                  {item.onMoveUp && (
                                    <ContextMenuItem onClick={item.onMoveUp} className="gap-2">
                                      <ArrowUp className="h-4 w-4" />
                                      Move Up
                                    </ContextMenuItem>
                                  )}
                                  {item.onMoveDown && (
                                    <ContextMenuItem onClick={item.onMoveDown} className="gap-2">
                                      <ArrowDown className="h-4 w-4" />
                                      Move Down
                                    </ContextMenuItem>
                                  )}
                                </>
                              )}
                              {item.onRename && (item.onDuplicate || item.onImport || item.onExport) && (
                                <ContextMenuSeparator />
                              )}
                              {item.onDuplicate && (
                                <ContextMenuItem onClick={item.onDuplicate} className="gap-2">
                                  <Copy className="h-4 w-4" />
                                  Duplicate
                                </ContextMenuItem>
                              )}
                              {(item.onImport || item.onExport) && (
                                <>
                                  {item.onDuplicate && <ContextMenuSeparator />}
                                  {item.onImport && (
                                    <ContextMenuItem onClick={item.onImport} className="gap-2">
                                      <Upload className="h-4 w-4" />
                                      Import
                                    </ContextMenuItem>
                                  )}
                                  {item.onExport && (
                                    <ContextMenuItem onClick={item.onExport} className="gap-2">
                                      <Download className="h-4 w-4" />
                                      Export
                                    </ContextMenuItem>
                                  )}
                                </>
                              )}
                              {item.onChangeColor && (
                                <>
                                  <ContextMenuSeparator />
                                  <ContextMenuSub>
                                    <ContextMenuSubTrigger className="gap-2">
                                      <Palette className="h-4 w-4" />
                                      Change color
                                    </ContextMenuSubTrigger>
                                    <ContextMenuSubContent className="w-48">
                                      <div className="grid grid-cols-4 gap-1 p-2">
                                        {coloredSquareColors.map((color) => (
                                          <Button
                                            key={color.value}
                                            variant="ghost"
                                            className={cn(
                                              "w-8 h-8 rounded-md transition-transform hover:scale-110 p-0",
                                              color.value,
                                              item.iconColor === color.value && "ring-2 ring-offset-2 ring-primary"
                                            )}
                                            onClick={() => item.onChangeColor?.(color.value)}
                                            title={color.label}
                                          />
                                        ))}
                                      </div>
                                    </ContextMenuSubContent>
                                  </ContextMenuSub>
                                </>
                              )}
                              {item.onChangeIcon && (
                                <ContextMenuSub>
                                  <ContextMenuSubTrigger className="gap-2">
                                    <ImageIcon className="h-4 w-4" />
                                    Change icon
                                  </ContextMenuSubTrigger>
                                  <ContextMenuSubContent className="w-56">
                                    <div className="grid grid-cols-5 gap-1 p-2">
                                      {coloredSquareIcons.map((iconOption) => {
                                        const IconComponent = iconOption.value;
                                        return (
                                          <Button
                                            key={iconOption.label}
                                            variant="ghost"
                                            size="icon"
                                            className={cn(
                                              "w-8 h-8 rounded-md flex items-center justify-center transition-colors hover:bg-accent",
                                              Icon === iconOption.value && "bg-accent ring-2 ring-primary"
                                            )}
                                            onClick={() => item.onChangeIcon?.(iconOption.value)}
                                            title={iconOption.label}
                                          >
                                            <IconComponent className="h-4 w-4" />
                                          </Button>
                                        );
                                      })}
                                    </div>
                                  </ContextMenuSubContent>
                                </ContextMenuSub>
                              )}
                              {item.onDelete && (
                                <>
                                  <ContextMenuSeparator />
                                  <ContextMenuItem
                                    onClick={item.onDelete}
                                    className="gap-2 text-red-600 focus:text-red-600"
                                  >
                                    <Trash2 className="h-4 w-4 text-red-600" />
                                    Delete
                                  </ContextMenuItem>
                                </>
                              )}
                            </ContextMenuContent>
                          </ContextMenu>
                        </SidebarMenuItem>
                        </MaybeSortable>
                      );
                    }

                    if (hasActionsContextMenu) {
                      return (
                        <MaybeSortable key={item.href}>
                        <SidebarMenuItem>
                          <ContextMenu>
                            <ContextMenuTrigger asChild>
                              {itemContent}
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              {item.actions!.map((action, idx) => {
                                const ActionIcon = action.icon;
                                const isDelete = action.label.toLowerCase() === 'delete';
                                const isArchive = action.label.toLowerCase() === 'archive';
                                const needsSeparator = (isDelete || isArchive) && idx > 0;
                                return (
                                  <React.Fragment key={idx}>
                                    {needsSeparator && <ContextMenuSeparator />}
                                    <ContextMenuItem
                                      onClick={action.onClick}
                                      className={isDelete ? "gap-2 text-red-600 focus:text-red-600 focus:bg-red-600/10" : "gap-2"}
                                    >
                                      {ActionIcon && <ActionIcon className={cn("h-4 w-4", isDelete && "text-red-600")} />}
                                      {action.label}
                                    </ContextMenuItem>
                                  </React.Fragment>
                                );
                              })}
                            </ContextMenuContent>
                          </ContextMenu>
                        </SidebarMenuItem>
                        </MaybeSortable>
                      );
                    }

                    return (
                      <MaybeSortable key={item.href}>
                      <SidebarMenuItem>
                        {itemContent}
                      </SidebarMenuItem>
                      </MaybeSortable>
                    );
                  });

                    return isDraggable ? (
                      <SortableContext items={group.items.map(i => i.href)} strategy={verticalListSortingStrategy}>
                        {itemsContent}
                      </SortableContext>
                    ) : itemsContent;
                  })()}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
          );
        })}
        </DndContext>
      </SidebarContent>
      <SidebarFooter suppressHydrationWarning>
        <ResourceUsage collapsed={state === "collapsed"} />
        <OnboardingChecklist collapsed={state === "collapsed"} />
        {showUpgradeButton && <UpgradeButton collapsed={state === "collapsed"} />}
        <InviteMemberButton collapsed={state === "collapsed"} />
        {user && (
          <SidebarUserMenu
            user={user}
            currentWorkspace={currentWorkspace}
            workspaces={workspaces}
            onWorkspaceSwitch={onWorkspaceSwitch}
            onWorkspaceCreate={onWorkspaceCreate}
            currentEmailAccount={currentEmailAccount}
            emailAccounts={emailAccounts}
            onEmailAccountSwitch={onEmailAccountSwitch}
            onEmailAccountAdd={onEmailAccountAdd}
            defaultEmailAccountId={defaultEmailAccountId}
            onSetDefaultEmailAccount={onSetDefaultEmailAccount}
            setDefaultLabel={setDefaultLabel}
            defaultLabel={defaultLabel}
            onSignOut={handleSignOut}
            onSettings={handleSettings}
            collapsed={state === "collapsed"}
            presence={presence ? { myStatus: presence.myStatus, setMyStatus: presence.setMyStatus } : undefined}
          />
        )}
        {footer}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
