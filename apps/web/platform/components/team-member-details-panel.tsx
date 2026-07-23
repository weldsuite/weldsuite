import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  X,
  EllipsisVertical,
  Mail,
  Trash2,
  Shield,
  ShieldCheck,
  Eye,
  Crown,
  User,
  Package as PackageIcon,
  Loader2,
  SquareActivity,
  Maximize,
  Minimize,
  LayoutGrid,
  LayoutDashboard,
  ChevronDown,
  ChevronRight,
  MessagesSquare,
  Phone,
  Video,
  Clock,
  Users,
  PanelLeftOpen,
  PanelRightOpen,
  Search,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { useDrawerFieldVisibility } from '@/hooks/use-drawer-field-visibility';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useDmByUser, weldchatKeys, mergeMessageIntoCache, updateMessageInCache, removeMessageFromCache } from '@/hooks/queries/use-weldchat-queries';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';
import { useWeldChatMessagesRealtime } from '@/hooks/weldchat/use-weldchat-messages-realtime';
import { useWeldChatPresence } from '@/hooks/weldchat/use-weldchat-presence';
import { MessageList } from '@/app/weldchat/components/message-list';
import { MessageInput } from '@/app/weldchat/components/message-input';
import { ChatContext, type ReplyTo, type RightPanel, type ChatFilters } from '@/app/weldchat/components/chat-context';
import {
  useMemberApps,
  useMemberPermissions,
  useUpdateMember,
  useUpdateMemberRole,
  useWorkspaceRoles,
  useToggleMemberApp,
  useMemberWorkingHours,
  useUpdateMemberWorkingHours,
  type WorkingHours,
} from '@/hooks/queries/use-settings-queries';
import { WorkingHoursEditor, DEFAULT_HOURS } from '@/components/working-hours/working-hours-editor';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { PERMISSION_CATALOG_OBJECTS, SYSTEM_ROLES, hasPermission } from '@weldsuite/permissions';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  STANDARD_ACTIONS,
  getActionLabels,
  COMING_SOON_CATEGORIES,
  CategoryIcon,
  ComingSoonBadge,
  categoryFor,
  groupByCategory,
  type StandardAction,
  type CategoryRow,
  type CategoryGroup,
} from '@/components/settings/permission-categories';
import { useComposeSafe } from '@/contexts/compose-context';
import { ActivitySection } from '@/components/customer-detail/sections/activity-section';
import type { TeamMember } from '@/components/settings/team-section';
import type { MemberAppAssignment } from '@/lib/api/types/rbac.types';
import { StatusDot, STATUS_LABELS, type PresenceStatus } from '@weldsuite/ui/components/status-dot';
import { usePresence } from '@/contexts/presence-context';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useMemberProfile } from '@/hooks/queries/use-team-queries';
import { OverviewTab as MemberOverviewTab } from '@/components/team-member-panel/tabs/overview-tab';
import { CommonTab as MemberCommonTab } from '@/components/team-member-panel/tabs/common-tab';
import { ActivityTab as MemberActivityTab } from '@/components/team-member-panel/tabs/activity-tab';
import { useAuth } from '@clerk/clerk-react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { APP_REGISTRY } from '@/lib/apps/app-registry';
import { useTheme } from '@/hooks/use-theme';

// ─── Unified Type ────────────────────────────────────────────────────

export interface TeamMemberDetail {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role: string; // System tier: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'
  /** Custom workspace role id when the member is assigned a non-system role. */
  roleId?: string | null;
  status: 'ACTIVE' | 'PENDING' | 'INACTIVE';
  joinedAt: Date | string;
  auth0Id?: string | null;
  userId?: string | null;
  workspaces?: Array<{ id: string; name: string; slug: string }>;
  allocationPercentage?: number;
  hoursPerWeek?: string | null;
  isActive?: boolean;
}

// ─── Adapter Functions ───────────────────────────────────────────────

export function fromTeamMember(member: TeamMember): TeamMemberDetail {
  const isPending = member.status === 'PENDING' || (!member.auth0Id && member.status !== 'ACTIVE');
  return {
    id: member.id,
    name: member.name || 'Unknown',
    email: member.email,
    avatar: member.picture ?? undefined,
    role: member.workspaceRole || 'MEMBER',
    roleId: member.workspaceRoleId ?? null,
    status: isPending ? 'PENDING' : (member.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'),
    joinedAt: member.createdAt,
    auth0Id: member.auth0Id,
    userId: member.userId,
    workspaces: member.workspaces,
    hoursPerWeek: member.hoursPerWeek,
  };
}

interface ProjectMemberInput {
  id: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt: string;
  allocationPercentage?: number;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

export function fromProjectMember(member: ProjectMemberInput): TeamMemberDetail {
  return {
    id: member.id,
    name: member.user?.name || 'Unknown User',
    email: member.user?.email || '',
    avatar: member.user?.avatar,
    role: member.role.toUpperCase(),
    status: member.isActive ? 'ACTIVE' : 'INACTIVE',
    joinedAt: member.joinedAt,
    userId: member.userId,
    allocationPercentage: member.allocationPercentage,
    isActive: member.isActive,
  };
}

// ─── Panel Props ─────────────────────────────────────────────────────

export interface TeamMemberDetailsPanelProps {
  member: TeamMemberDetail | null;
  isOpen: boolean;
  onClose: () => void;
  canManageMembers: boolean;
  onRemoveMember: (memberId: string) => void;
  onMemberUpdated: () => void;
  context: 'settings' | 'projects';
  onRoleChange?: (memberId: string, newRole: string) => Promise<void>;
  projectsConfig?: { projectId: string };
  closeIcon?: React.ReactNode;
  skipAnimation?: boolean;
  /** When true, skip the outer fixed-position wrapper and render only the inner content. */
  renderContentOnly?: boolean;
  /** When true, hide the embedded DM chat (e.g. when already viewing the DM conversation). */
  hideMessages?: boolean;
  /** Initial value for the expanded state. Defaults to false (collapsed side panel). */
  defaultExpanded?: boolean;
  /** Override the Maximize button click. When provided, the panel does NOT toggle internal state — the host decides what happens (e.g. navigate to a dedicated route). */
  onExpand?: (memberId: string) => void;
  /** Override the in-expanded "collapse" button. When provided, the panel does NOT toggle internal state. */
  onCollapse?: () => void;
}

type MemberTab = 'messages' | 'profile' | 'notes' | 'common' | 'activity' | 'overview' | 'permissions' | 'working-hours';

const baseTabItems: PageTab[] = [
  { id: 'profile', label: 'Details', icon: LayoutDashboard },
  { id: 'messages', label: 'Messages', icon: MessagesSquare },
  { id: 'common', label: 'Common', icon: Users },
];

const activityTabItem: PageTab = { id: 'activity', label: 'Activity', icon: SquareActivity };

const expandedTabItems: PageTab[] = [
  { id: 'overview', label: 'Details', icon: LayoutDashboard },
  { id: 'common', label: 'Common', icon: Users },
  { id: 'activity', label: 'Activity', icon: SquareActivity },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'working-hours', label: 'Working Hours', icon: Clock },
];

function EmbeddedDmChat({ targetUserId }: { targetUserId: string }) {
  const { data, isLoading } = useDmByUser(targetUserId);
  const queryClient = useQueryClient();
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [filters, setFilters] = useState<ChatFilters>({ type: 'all', search: '', from: [], date: undefined });

  const chatContextValue = React.useMemo(() => ({
    activeChannelId: null,
    setActiveChannelId: () => {},
    rightPanel,
    setRightPanel,
    threadMessageId,
    openThread: (messageId: string) => setThreadMessageId(messageId),
    closeThread: () => setThreadMessageId(null),
    replyTo,
    setReplyTo,
    filters,
    setFilters,
    selectedProfileUserId: null,
    openUserProfile: () => {},
    closeUserProfile: () => {},
    selectedAgentProfileId: null,
    openAgentProfile: () => {},
    closeAgentProfile: () => {},
  }), [rightPanel, threadMessageId, replyTo, filters]);

  const channel = data?.data;
  const channelId = channel?.id;

  const { client: room } = useWeldChatRoom(channelId ?? null);

  const onMessageCreated = useCallback((message: any) => {
    if (!channelId) return;
    mergeMessageIntoCache(queryClient, channelId, message);
    queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });
  }, [channelId, queryClient]);

  const onMessageUpdated = useCallback((message: any) => {
    if (!channelId) return;
    updateMessageInCache(queryClient, channelId, message.id, message);
  }, [channelId, queryClient]);

  const onMessageDeleted = useCallback((messageId: string) => {
    if (!channelId) return;
    removeMessageFromCache(queryClient, channelId, messageId);
  }, [channelId, queryClient]);

  useWeldChatMessagesRealtime(room, channelId ?? null, {
    onMessageCreated,
    onMessageUpdated,
    onMessageDeleted,
  });

  useWeldChatPresence(room);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (!channelId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Start a conversation
      </div>
    );
  }

  return (
    <ChatContext.Provider value={chatContextValue}>
      <div className="flex-1 flex flex-col min-h-0">
        <MessageList channelId={channelId} client={room} />
        <MessageInput channelId={channelId} client={room} />
      </div>
    </ChatContext.Provider>
  );
}

function getRoleLabel(role: string) {
  switch (role) {
    case 'OWNER': return 'Owner';
    case 'ADMIN': return 'Admin';
    case 'MEMBER': return 'Member';
    case 'VIEWER': return 'Viewer';
    default:
      // A custom-role id (e.g. `role_…`) whose name hasn't resolved from the
      // workspace-roles list yet. Don't masquerade it as "Member" — that made an
      // assigned custom role look like it had silently fallen back to Member.
      return role.startsWith('role_') ? 'Custom role' : 'Member';
  }
}

export function TeamMemberDetailsPanel({
  member,
  isOpen,
  onClose,
  canManageMembers,
  onRemoveMember,
  onMemberUpdated,
  context,
  onRoleChange,
  projectsConfig,
  closeIcon,
  skipAnimation,
  renderContentOnly,
  hideMessages,
  defaultExpanded = false,
  onExpand,
  onCollapse,
}: TeamMemberDetailsPanelProps) {
  const width = '480px';
  const widthNum = 480;
  const { getClient } = useAppApiClient();
  const [updatingApps, setUpdatingApps] = useState<Record<string, boolean>>({});

  // Workspace-level admin check — independent of the caller's canManageMembers
  // (which is specific to the enclosing context, e.g. "can remove from project").
  // Anyone with team:read (or owner) can view another member's activity.
  const perms = usePermissionsMaybe();
  const viewerIsWorkspaceAdmin = !!perms && (perms.isOwner || perms.canAny('team:read', 'team:update'));
  // localRole is the value driving the role <Select>. For custom roles we use
  // `member.roleId` (the row in the roles table); for system roles we use
  // `member.role` (the system tier string OWNER/ADMIN/MEMBER/VIEWER).
  const [localRole, setLocalRole] = useState(member?.roleId || member?.role || 'MEMBER');
  const [activeTab, setActiveTab] = useState<MemberTab>(defaultExpanded ? 'overview' : 'profile');
  // `isExpanded` — the user's *intent* (flips immediately on click, drives the
  // width animation).
  // `renderExpanded` — *which subtree* to render. Decoupled from intent so the
  // heavy expanded layout (with chat panel + queries) doesn't commit at the
  // exact moment the width is animating, which starves the compositor and
  // makes the panel briefly disappear/flicker. On expand we swap the layout
  // immediately and let the width grow around it; on collapse we keep the
  // expanded layout rendered for the duration of the shrink and only swap to
  // the compact layout once the width animation has finished.
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [renderExpanded, setRenderExpanded] = useState(defaultExpanded);

  const TEAM_MEMBER_CHAT_OPEN_KEY = 'team-member-panel-chat-open';
  const [chatPanelOpen, setChatPanelOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const raw = window.localStorage.getItem(TEAM_MEMBER_CHAT_OPEN_KEY);
    if (raw === null) return true;
    return raw === 'true';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(TEAM_MEMBER_CHAT_OPEN_KEY, chatPanelOpen ? 'true' : 'false');
  }, [chatPanelOpen]);
  const DEFAULT_TEAM_MEMBER_CHAT_WIDTH = 500;
  const MIN_TEAM_MEMBER_CHAT_WIDTH = 320;
  const MAX_TEAM_MEMBER_CHAT_WIDTH = 1100;
  // Chat panel width is always the standard 500px on every load and every
  // panel open. Not persisted — drag-resizes apply only to the current
  // session and reset on reload / reopen.
  const [chatPanelWidth, setChatPanelWidth] = useState<number>(DEFAULT_TEAM_MEMBER_CHAT_WIDTH);
  const toggleChatPanel = useCallback(() => {
    setChatPanelOpen((wasOpen) => {
      // Reopening the chat resets the width to the default. We deliberately
      // do NOT remember the user's last drag-resized width across close/open
      // cycles — the user expects a fresh default every time the chat
      // reappears, even if they previously dragged it wider or narrower.
      if (!wasOpen) setChatPanelWidth(DEFAULT_TEAM_MEMBER_CHAT_WIDTH);
      return !wasOpen;
    });
  }, []);

  const chatResizeDragRef = useRef(false);
  const handleChatResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    chatResizeDragRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!chatResizeDragRef.current) return;
      const next = Math.max(
        MIN_TEAM_MEMBER_CHAT_WIDTH,
        Math.min(MAX_TEAM_MEMBER_CHAT_WIDTH, window.innerWidth - e.clientX),
      );
      setChatPanelWidth(next);
    };
    const onMouseUp = () => {
      if (!chatResizeDragRef.current) return;
      chatResizeDragRef.current = false;
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

  const {
    isFieldVisible: isCollapsedTabVisible,
    fields: collapsedTabFields,
    fieldVisibility: collapsedTabVisibility,
    toggleField: toggleCollapsedTab,
    resetToDefaults: resetCollapsedTabs,
  } = useDrawerFieldVisibility('team-member-detail-panel');

  // Smooth width transition when toggling expand. Uses the same easing as the
  // customer detail panel so cross-panel transitions feel consistent.
  //
  // Important timing detail: the maximize/minimize click handlers (below) set
  // `animatingWidth` and `renderExpanded` *synchronously alongside*
  // `isExpanded` so that all three flip in a single React render. If we set
  // them later (e.g. from a `useEffect` keyed on `isExpanded`), the first
  // render after the click would commit a width change with no transition
  // active — the browser would snap to the new width and the transition we
  // add on the second render has nothing to interpolate. Batching them into
  // one render lets the browser see "width changed AND a transition is
  // active" in the same paint, which is the condition that triggers the
  // animation.
  const PANEL_TRANSITION_MS = 300;
  const PANEL_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const [animatingWidth, setAnimatingWidth] = useState(false);
  const animTimerRef = useRef<number | null>(null);
  const clearAnimTimer = useCallback(() => {
    if (animTimerRef.current !== null) {
      window.clearTimeout(animTimerRef.current);
      animTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => clearAnimTimer(), [clearAnimTimer]);

  // Maximize / minimize handlers.
  //
  // Both follow the same sequence: flip the local `isExpanded` state so the
  // width animation plays in the current panel, then (if the host wants to
  // navigate) call back AFTER the animation finishes. The destination route is
  // expected to mount the panel with `skipAnimation=true` so the user perceives
  // a single continuous resize rather than a remount-and-reanimate.
  //
  // The nav callback is fired via `navTimerRef`, which we clear on unmount and
  // on every fresh maximize/minimize click. That prevents a stale "navigate to
  // expanded" from firing after the user already closed the panel, and stops
  // rapid double-clicks from firing the host callback twice.
  const navTimerRef = useRef<number | null>(null);
  const clearNavTimer = useCallback(() => {
    if (navTimerRef.current !== null) {
      window.clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
  }, []);

  // Tab id mapping between collapsed and expanded views. Collapsed uses
  // 'profile' (and exposes a 'messages' tab); expanded uses 'overview' and has
  // no messages tab. Without this remap, the user's selected tab disappears
  // when toggling and the content area renders blank.
  const mapTabToExpanded = (tab: MemberTab): MemberTab => {
    switch (tab) {
      case 'profile':
      case 'messages':
        return 'overview';
      default:
        return tab;
    }
  };
  const mapTabToCollapsed = (tab: MemberTab): MemberTab => {
    switch (tab) {
      case 'overview':
      case 'working-hours':
        return 'profile';
      default:
        return tab;
    }
  };

  const handleMaximize = useCallback(() => {
    if (!member) return;

    // All four state updates batch into a single render so that the browser's
    // first paint after the click already has both the new width AND the
    // active CSS transition — that's what makes the width grow animate
    // smoothly instead of snapping. `renderExpanded` swaps the layout
    // immediately so the chat panel + tabs settle while the width opens
    // around them.
    clearAnimTimer();
    setAnimatingWidth(true);
    setRenderExpanded(true);
    setIsExpanded(true);
    setActiveTab((t) => mapTabToExpanded(t));

    animTimerRef.current = window.setTimeout(() => {
      animTimerRef.current = null;
      setAnimatingWidth(false);
    }, PANEL_TRANSITION_MS);

    if (onExpand) {
      clearNavTimer();
      const memberId = member.id;
      navTimerRef.current = window.setTimeout(() => {
        navTimerRef.current = null;
        onExpand(memberId);
      }, PANEL_TRANSITION_MS);
    }
  }, [member, onExpand, clearAnimTimer, clearNavTimer]);

  const handleMinimize = useCallback(() => {
    // Collapse: swap to the compact layout immediately so the *narrower*
    // collapsed tabs row is what animates as the width shrinks. Keeping the
    // expanded tabs rendered through the resize (the previous approach)
    // looked messy near the end — the wider 5-tab expanded row visibly
    // overflowed as the panel narrowed, then snapped to the collapsed row
    // at the very end. Swapping up-front lets the collapsed layout sit
    // neatly inside the shrinking container instead.
    clearAnimTimer();
    setAnimatingWidth(true);
    setRenderExpanded(false);
    setIsExpanded(false);
    setActiveTab((t) => mapTabToCollapsed(t));

    animTimerRef.current = window.setTimeout(() => {
      animTimerRef.current = null;
      setAnimatingWidth(false);
    }, PANEL_TRANSITION_MS);

    if (onCollapse) {
      clearNavTimer();
      navTimerRef.current = window.setTimeout(() => {
        navTimerRef.current = null;
        onCollapse();
      }, PANEL_TRANSITION_MS);
    }
  }, [onCollapse, clearAnimTimer, clearNavTimer]);

  useEffect(() => () => clearNavTimer(), [clearNavTimer]);

  const composeContext = useComposeSafe();
  const navigate = useNavigate();

  const isPending = member?.status === 'PENDING';
  const isOwner = member?.role === 'OWNER';
  const memberStatus = member?.status || 'ACTIVE';

  // Settings-specific React Query hooks — disabled when not in settings context
  const isSettings = context === 'settings';
  const { data: memberAppsData } = useMemberApps(member?.id || '', isOpen && !!member && isSettings);
  const { data: memberPermsData } = useMemberPermissions(member?.id || '', isOpen && !!member && isSettings);
  const { data: workspaceRolesData } = useWorkspaceRoles(isOpen && isSettings);
  const updateMemberMutation = useUpdateMember();
  const updateRoleMutation = useUpdateMemberRole();
  const toggleAppMutation = useToggleMemberApp();

  const memberApps = isSettings ? ((memberAppsData?.data as MemberAppAssignment[]) ?? []) : [];
  const workspaceRoles = workspaceRolesData?.data ?? [];
  const updatingRole = isSettings ? updateRoleMutation.isPending : false;
  const rolePermissions = memberPermsData?.data?.rolePermissions ?? [];
  const memberOverrides = memberPermsData?.data?.memberOverrides ?? [];

  const [localHoursPerWeek, setLocalHoursPerWeek] = useState(member?.hoursPerWeek ?? '40');
  const [localAllocation, setLocalAllocation] = useState(String(member?.allocationPercentage ?? 100));

  // Sync local role when member data updates
  useEffect(() => {
    if (member) {
      setLocalRole(member.roleId || member.role || 'MEMBER');
      setLocalHoursPerWeek(member.hoursPerWeek ?? '40');
      setLocalAllocation(String(member.allocationPercentage ?? 100));
    }
  }, [member]);

  // Reset expanded state only when switching to a different member
  const memberIdRef = useRef(member?.id);
  useEffect(() => {
    if (member?.id !== memberIdRef.current) {
      setIsExpanded(false);
      memberIdRef.current = member?.id;
    }
  }, [member?.id]);

  // Close WeldAgent when panel opens
  useEffect(() => {
    if (isOpen) {
      window.dispatchEvent(new CustomEvent('close-weldagent'));
    }
  }, [isOpen]);

  // Notify layout of panel open/close so content width adjusts.
  //
  // We deliberately report a fixed `widthNum` (the collapsed width) regardless
  // of `isExpanded`. The page layout listens to this event to decide how much
  // space to reserve next to the panel. If we toggled the reported width
  // between `widthNum` (collapsed) and `0` (expanded), every maximize/minimize
  // would yank the page content sideways at the same time as the panel was
  // animating its own width — which the user reads as the "page going all
  // directions". Keeping the reservation constant means the page underneath
  // stays put; the expanded panel just overlays more of it on top.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('member-detail-panel', {
      detail: { isOpen, width: widthNum },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent('member-detail-panel', {
        detail: { isOpen: false, width: 0 },
      }));
    };
  }, [isOpen, widthNum]);

  // Close panel when WeldAgent opens
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, [onClose]);

  // Animation key — used as the React `key` on the outer panel element so the
  // entrance slide-in re-plays whenever the panel newly opens or switches to a
  // different member. Critically, this does NOT depend on `isExpanded`: a
  // maximize/minimize click must not bump the key, otherwise the element
  // remounts and the slide-in plays again on top of the width animation
  // (which the user perceives as the panel disappearing and reappearing).
  const [animationKey, setAnimationKey] = useState(0);
  const prevMemberIdRef = useRef<string | null>(null);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setAnimationKey((k) => k + 1);
    }
    if (isOpen && member?.id && member.id !== prevMemberIdRef.current && prevMemberIdRef.current !== null) {
      setAnimationKey((k) => k + 1);
    }
    prevOpenRef.current = isOpen;
    prevMemberIdRef.current = member?.id ?? null;
  }, [isOpen, member?.id]);

  const handleResendInvite = async () => {
    if (!member || context !== 'settings') return;
    try {
      const client = await getClient();
      // app-api POST /api/team-members/:id/resend-invite (was api-worker
      // /settings/members/:id/resend-invite). Failures throw.
      await client.post<{ data: { success: boolean } }>(
        `/team-members/${member.id}/resend-invite`,
        {}
      );
      toast.success('Invitation resent to ' + member.email);
    } catch {
      toast.error('Failed to resend invitation');
    }
  };

  const handleRoleChange = async (newRole: string) => {
    if (!member || isOwner) return;

    if (context === 'projects' && onRoleChange) {
      try {
        await onRoleChange(member.id, newRole);
        setLocalRole(newRole);
      } catch {
        toast.error('Failed to update role');
      }
      return;
    }

    // Settings context — system roles are sent as `role`, custom roles as `roleId`.
    // We dispatch by checking the loaded workspace-role list: if the picked
    // value matches a non-system role's id, it's custom.
    const matchedRole = workspaceRoles.find((r) => r.id === newRole);
    const data =
      matchedRole && !matchedRole.isSystemRole
        ? { roleId: newRole }
        : { role: newRole };
    try {
      const result = await updateRoleMutation.mutateAsync({
        id: member.id,
        data,
      });
      if (result.success) {
        setLocalRole(newRole);
        toast.success('Member role updated');
        onMemberUpdated();
      } else {
        toast.error('Failed to update role');
      }
    } catch {
      toast.error('Failed to update role');
    }
  };

  const handleAppToggle = async (appCode: string, currentlyAssigned: boolean) => {
    if (!member || context !== 'settings') return;
    setUpdatingApps((prev) => ({ ...prev, [appCode]: true }));
    try {
      const result = await toggleAppMutation.mutateAsync({
        id: member.id,
        appCode,
        enabled: !currentlyAssigned,
      });
      if (result.success) {
        toast.success(`App ${!currentlyAssigned ? 'enabled' : 'disabled'}`);
      } else {
        toast.error('Failed to update app access');
      }
    } catch {
      toast.error('Failed to update app access');
    } finally {
      setUpdatingApps((prev) => ({ ...prev, [appCode]: false }));
    }
  };

  const handleHoursPerWeekSave = async () => {
    if (!member || context !== 'settings') return;
    const value = parseFloat(localHoursPerWeek);
    if (isNaN(value) || value < 0 || value > 168) {
      toast.error('Hours per week must be between 0 and 168');
      setLocalHoursPerWeek(member.hoursPerWeek ?? '40');
      return;
    }
    try {
      const result = await updateMemberMutation.mutateAsync({
        id: member.id,
        data: { hoursPerWeek: String(value) },
      });
      if (result.success) {
        toast.success('Working hours updated');
        onMemberUpdated();
      } else {
        toast.error('Failed to update working hours');
      }
    } catch {
      toast.error('Failed to update working hours');
    }
  };

  const handleAllocationSave = async () => {
    if (!member || !member.userId || context !== 'projects' || !projectsConfig) return;
    const value = parseInt(localAllocation);
    if (isNaN(value) || value < 0 || value > 100) {
      toast.error('Allocation must be between 0 and 100');
      setLocalAllocation(String(member.allocationPercentage ?? 100));
      return;
    }
    try {
      const client = await getClient();
      // app-api PATCH /api/project-members/by-user/:projectId/:userId (was
      // api-worker PUT /weldflow/:projectId/members/:userId). Failures throw.
      await client.patch<{ data: { projectId: string; userId: string } }>(
        `/project-members/by-user/${projectsConfig.projectId}/${member.userId}`,
        { allocationPercentage: value },
      );
      toast.success('Allocation updated');
      onMemberUpdated();
    } catch {
      toast.error('Failed to update allocation');
    }
  };

  if (!isOpen || !member) {
    // When skipAnimation is set and panel should be open, render invisible placeholder
    // to reserve space and prevent layout shift when data loads
    if (skipAnimation && isOpen && !member) {
      return (
        <div
          className="fixed bg-background z-50 flex flex-col border-l border-border inset-0 md:inset-auto md:right-0 md:top-[60px] md:bottom-0"
          style={{ width }}
        />
      );
    }
    return null;
  }

  const memberAsCustomer = {
    type: 'b2b' as const,
    companyName: member.name || 'Unknown',
    name: member.name || 'Unknown',
    firstName: member.name?.split(' ')[0] || '',
    lastName: member.name?.split(' ').slice(1).join(' ') || '',
    email: member.email,
    phone: '',
    description: '',
    website: '',
    tags: [],
    industry: '',
    billingAddress: {},
    createdAt: member.joinedAt,
    id: member.id,
  };

  const panelContent = (
    <>
      {renderExpanded ? (
        <ExpandedMemberContent
          member={member}
          memberAsCustomer={memberAsCustomer}
          isPending={isPending}
          isOwner={isOwner}
          memberStatus={memberStatus}
          localRole={localRole}
          updatingRole={updatingRole}
          canManageMembers={canManageMembers}
          memberApps={memberApps}
          updatingApps={updatingApps}
          rolePermissions={rolePermissions}
          memberOverrides={memberOverrides}
          updateMemberMutation={updateMemberMutation}
          activeTab={activeTab}
          context={context}
          workspaceRoles={workspaceRoles}
          onTabChange={(id) => setActiveTab(id as MemberTab)}
          onClose={onClose}
          onToggleExpand={handleMinimize}
          onResendInvite={handleResendInvite}
          onRemoveMember={onRemoveMember}
          onRoleChange={handleRoleChange}
          onAppToggle={handleAppToggle}
          onMemberUpdated={onMemberUpdated}
          onComposeEmail={(email) => composeContext?.openCompose({ to: email })}
          onOpenChat={(userId) => {
            navigate({ to: '/weldchat/dm/$userId', params: { userId } });
            onClose();
          }}
          chatPanelOpen={chatPanelOpen}
          onToggleChatPanel={toggleChatPanel}
          chatPanelWidth={chatPanelWidth}
          onChatResizeMouseDown={handleChatResizeMouseDown}
        />
      ) : (
        <>
          {/* Header — avatar + presence, name + local time, action icons.
              Height matches the expanded header (h-[53px]) so the row doesn't
              shift vertically when toggling maximize/minimize. */}
          <div className="group/header flex items-center justify-between h-[53px] px-3 md:px-4 flex-shrink-0">
            <MemberHeaderIdentity member={member} />

            <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
              <MemberCallButtons userId={member.userId} />

              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-muted rounded-md transition-colors"
                title="Compose email"
                onClick={() => composeContext?.openCompose({ to: member.email })}
              >
                <Mail className="h-4 w-4 text-gray-500" />
              </Button>

              {member.userId && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="p-1.5 hover:bg-muted rounded-md transition-colors"
                  title="Open chat"
                  onClick={() => {
                    navigate({
                      to: '/weldchat/dm/$userId',
                      params: { userId: member.userId! },
                    });
                    onClose();
                  }}
                >
                  <MessagesSquare className="h-4 w-4 text-gray-500" />
                </Button>
              )}

              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-muted rounded-md transition-colors"
                onClick={handleMaximize}
                title="Expand"
              >
                <Maximize className="h-4 w-4 text-gray-500" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-muted rounded-md transition-colors"
                onClick={onClose}
                title="Close"
              >
                {closeIcon || <X className="h-4 w-4 text-gray-500" />}
              </Button>
            </div>
          </div>

          {/* Tabs + Content area */}
          {(() => {
            const allTabs = buildCollapsedTabs({
              hideMessages,
              canViewActivity: viewerIsWorkspaceAdmin,
              showPermissions: isSettings,
            });
            const visibleTabs = allTabs.filter((t) => isCollapsedTabVisible(t.id));
            const fallbackTab = (visibleTabs[0]?.id ?? 'profile') as MemberTab;
            const effectiveActive: MemberTab = visibleTabs.some((t) => t.id === activeTab)
              ? (hideMessages && activeTab === 'messages' ? 'profile' : activeTab)
              : fallbackTab;
            return (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="relative z-10">
                  <PageTabs
                    tabs={visibleTabs}
                    activeTab={effectiveActive}
                    onTabChange={(id) => setActiveTab(id as MemberTab)}
                    innerClassName="px-4 pt-1"
                    className="group/tabs-header"
                  >
                    <div className="ml-auto flex items-center pl-2 flex-shrink-0 self-center -translate-y-[4px] opacity-0 group-hover/tabs-header:opacity-100 transition-opacity">
                      <DrawerFieldSettings
                        fields={collapsedTabFields.filter((f) => allTabs.some((t) => t.id === f.id))}
                        fieldVisibility={collapsedTabVisibility}
                        onToggle={toggleCollapsedTab}
                        onReset={resetCollapsedTabs}
                        label="Visible tabs"
                        maxVisible={3}
                      />
                    </div>
                  </PageTabs>
                </div>

                {effectiveActive === 'permissions' && isSettings ? (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <PermissionsContent
                      member={member}
                      isOwner={isOwner}
                      localRole={localRole}
                      updatingRole={updatingRole}
                      canManageMembers={canManageMembers}
                      memberApps={memberApps}
                      updatingApps={updatingApps}
                      rolePermissions={rolePermissions}
                      memberOverrides={memberOverrides}
                      updateMemberMutation={updateMemberMutation}
                      context={context}
                      workspaceRoles={workspaceRoles}
                      onRoleChange={handleRoleChange}
                      onAppToggle={handleAppToggle}
                      onMemberUpdated={onMemberUpdated}
                    />
                  </div>
                ) : (
                  <CollapsedTabContent
                    tab={effectiveActive}
                    member={member}
                    hideMessages={hideMessages}
                    canViewActivity={viewerIsWorkspaceAdmin}
                  />
                )}
              </div>
            );
          })()}
        </>
      )}
    </>
  );

  if (renderContentOnly) return panelContent;

  return (
    <div
      key={skipAnimation ? 'static' : animationKey}
      className={cn(
        'fixed bg-background z-50 flex flex-col',
        !isExpanded && 'border-l border-border',
        'inset-0',
        'md:inset-auto md:right-0 md:top-[60px] md:bottom-0',
        // While the width is animating, clip any content that would otherwise
        // bleed past the shrinking/growing panel edge. Lifted again at rest so
        // popovers, dropdowns and tooltips that anchor to the panel edge don't
        // get clipped in steady state.
        animatingWidth && 'overflow-hidden',
        // Mount-time entrance only. We deliberately do NOT toggle this class
        // based on `animatingWidth` — toggling it off and back on while the
        // element stays mounted causes the CSS animation to *replay* (slide in
        // from translateX(100%) and fade from 50% opacity), which on a
        // maximize/minimize click reads as the panel disappearing and then
        // reappearing. The `key` on this element (animationKey) is what
        // controls when the entrance should play; once the element has
        // mounted, this class is inert.
        !skipAnimation && 'animate-in slide-in-from-right fade-in-50 duration-300',
      )}
      style={{
        width: isExpanded ? 'calc(100% - 64px - 16rem)' : width,
        transition: animatingWidth ? `width ${PANEL_TRANSITION_MS}ms ${PANEL_EASING}` : undefined,
        willChange: animatingWidth ? 'width' : undefined,
      }}
    >
      {panelContent}
    </div>
  );
}

/* ─── Expanded Panel Content ──────────────────────────────────────────── */

function ExpandedMemberContent({
  member,
  memberAsCustomer,
  isPending,
  isOwner,
  memberStatus,
  localRole,
  updatingRole,
  canManageMembers,
  memberApps,
  updatingApps,
  rolePermissions,
  memberOverrides,
  updateMemberMutation,
  activeTab,
  context,
  workspaceRoles,
  onTabChange,
  onClose,
  onToggleExpand,
  onResendInvite,
  onRemoveMember,
  onRoleChange,
  onAppToggle,
  onMemberUpdated,
  onComposeEmail,
  onOpenChat,
  chatPanelOpen,
  onToggleChatPanel,
  chatPanelWidth,
  onChatResizeMouseDown,
}: {
  member: TeamMemberDetail;
  memberAsCustomer: any;
  isPending: boolean;
  isOwner: boolean;
  memberStatus: string;
  localRole: string;
  updatingRole: boolean;
  canManageMembers: boolean;
  memberApps: MemberAppAssignment[];
  updatingApps: Record<string, boolean>;
  rolePermissions: string[];
  memberOverrides: string[];
  updateMemberMutation: ReturnType<typeof useUpdateMember>;
  activeTab: MemberTab;
  context: 'settings' | 'projects';
  workspaceRoles: WorkspaceRoleOption[];
  onTabChange: (id: string) => void;
  onClose: () => void;
  onToggleExpand: () => void;
  onResendInvite: () => void;
  onRemoveMember: (memberId: string) => void;
  onRoleChange: (role: string) => void;
  onAppToggle: (appCode: string, currentlyAssigned: boolean) => void;
  onMemberUpdated: () => void;
  onComposeEmail?: (email: string) => void;
  onOpenChat?: (userId: string) => void;
  chatPanelOpen: boolean;
  onToggleChatPanel: () => void;
  chatPanelWidth: number;
  onChatResizeMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <>
      {/* Expanded Header */}
      <div className="flex flex-col bg-background">
        <div className="flex items-center justify-between h-[53px] px-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              {member.avatar ? (
                <img
                  src={member.avatar}
                  alt={member.name || ''}
                  className="w-7 h-7 rounded-lg object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-7 h-7 rounded-lg bg-purple-100 dark:bg-purple-900 flex items-center justify-center flex-shrink-0">
                  <User className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                </div>
              )}
              <span className="text-[17px] font-semibold text-foreground truncate max-w-[200px] translate-y-[0.5px]">
                {member.name || 'Unknown'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-0.5 md:gap-1">
            <MemberCallButtons userId={member.userId} />

            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              title="Compose email"
              onClick={() => onComposeEmail?.(member.email)}
            >
              <Mail className="h-4 w-4 text-gray-500" />
            </Button>

            {member.userId && (
              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-muted rounded-md transition-colors"
                title="Open chat"
                onClick={() => onOpenChat?.(member.userId!)}
              >
                <MessagesSquare className="h-4 w-4 text-gray-500" />
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={onToggleExpand}
              title="Minimize"
            >
              <Minimize className="h-4 w-4 text-gray-500" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={onClose}
              title="Close"
            >
              <X className="h-4 w-4 text-gray-500" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main Layout with Tabs + Content + Sidebar */}
      {/* Tabs (full width, above content + chat) */}
      <div className="relative z-10">
        <PageTabs
          tabs={expandedTabItems}
          activeTab={activeTab}
          onTabChange={onTabChange}
          innerClassName="px-4 pt-1"
        />
        <div className="absolute top-0 right-0 h-full flex items-center pr-2 md:pr-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleChatPanel}
            aria-label={chatPanelOpen ? 'Close chat' : 'Open chat'}
            title={chatPanelOpen ? 'Close chat' : 'Open chat'}
            className="h-7 w-7 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            {chatPanelOpen ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Section — active tab content */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div className="flex-1 overflow-y-auto overflow-x-hidden customer-detail-scroll">
            {activeTab === 'overview' && (
              <div className="px-4 py-10">
                <div className="w-[848px] max-w-full mx-auto">
                  <ExpandedOverviewContent
                    member={member}
                    memberAsCustomer={memberAsCustomer}
                    memberStatus={memberStatus}
                    context={context}
                    onMemberUpdated={onMemberUpdated}
                  />
                </div>
              </div>
            )}
            {activeTab === 'common' && (
              <div className="px-4 py-10">
                <div className="w-[848px] max-w-full mx-auto">
                  <ExpandedCommonContent userId={member.userId ?? null} />
                </div>
              </div>
            )}
            {activeTab === 'working-hours' && canManageMembers && (
              <MemberWorkingHoursContent memberId={member.id} memberName={member.name || member.email} />
            )}
            {activeTab === 'activity' && (
              <div className="px-4 py-10">
                <div className="w-[848px] max-w-full mx-auto">
                  <ActivitySection
                    customer={memberAsCustomer as any}
                    activities={[
                      {
                        id: `${member.id}-created`,
                        type: 'customer_created',
                        subject: isPending ? 'Invitation sent' : 'Joined the workspace',
                        assignedToId: '',
                        status: 'completed',
                        createdAt: typeof member.joinedAt === 'string' ? member.joinedAt : new Date(member.joinedAt).toISOString(),
                        updatedAt: typeof member.joinedAt === 'string' ? member.joinedAt : new Date(member.joinedAt).toISOString(),
                      },
                    ]}
                    totalCount={1}
                  />
                </div>
              </div>
            )}
            {activeTab === 'permissions' && (
              <PermissionsContent
                member={member}
                isOwner={isOwner}
                localRole={localRole}
                updatingRole={updatingRole}
                canManageMembers={canManageMembers}
                memberApps={memberApps}
                updatingApps={updatingApps}
                rolePermissions={rolePermissions}
                memberOverrides={memberOverrides}
                updateMemberMutation={updateMemberMutation}
                context={context}
                workspaceRoles={workspaceRoles}
                onRoleChange={onRoleChange}
                onAppToggle={onAppToggle}
                onMemberUpdated={onMemberUpdated}
              />
            )}
          </div>
        </div>

        {/* Right Sidebar — chat only, sits below the full-width tabs row */}
        {chatPanelOpen && (
          <div
            className="relative flex-shrink-0 bg-background flex flex-col border-l border-border overflow-hidden"
            style={{ width: chatPanelWidth }}
          >
            {/* Resize handle on the left edge — drag to resize */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group"
              onMouseDown={onChatResizeMouseDown}
            >
              <div className="absolute inset-y-0 -left-1 -right-1 flex items-center justify-center">
                <div className="h-6 w-1 rounded-full bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-accent transition-colors" />
              </div>
            </div>
            {member.userId ? (
              <EmbeddedDmChat targetUserId={member.userId} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                No user ID available for direct messaging
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Expanded Common Content ─────────────────────────────────────────── */

function ExpandedCommonContent({ userId }: { userId: string | null }) {
  const { userId: viewerUserId } = useAuth();
  if (!userId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No user ID available
      </div>
    );
  }
  const isSelf = !!viewerUserId && viewerUserId === userId;
  return <MemberCommonTab userId={userId} isSelf={isSelf} />;
}

/* ─── Expanded Details Content ────────────────────────────────────────── */

function ExpandedOverviewContent({
  member,
}: {
  member: TeamMemberDetail;
  memberAsCustomer: any;
  memberStatus: string;
  context: 'settings' | 'projects';
  onMemberUpdated: () => void;
}) {
  // Render the same Details content the collapsed panel shows, so toggling
  // maximize/minimize doesn't switch the user between two visually different
  // representations of the same tab.
  const profileQuery = useMemberProfile(member.userId || undefined);

  if (profileQuery.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (!profileQuery.data) {
    return (
      <div className="flex-1 flex items-center justify-center py-12 text-sm text-muted-foreground">
        Member not found.
      </div>
    );
  }

  return <MemberOverviewTab profile={profileQuery.data} />;
}

/* ─── Permissions Tab Content ─────────────────────────────────────────── */

const ROLE_CARDS: {
  value: string;
  label: string;
  description: string;
  icon: React.ElementType;
  color: string;
}[] = [
  {
    value: 'ADMIN',
    label: 'Admin',
    description: 'Full access, manage members & integrations',
    icon: ShieldCheck,
    color: 'text-blue-600 dark:text-blue-400',
  },
  {
    value: 'MEMBER',
    label: 'Member',
    description: 'Access features, create & manage own content',
    icon: User,
    color: 'text-green-600 dark:text-green-400',
  },
  {
    value: 'VIEWER',
    label: 'Viewer',
    description: 'View-only access to workspace content',
    icon: Eye,
    color: 'text-gray-600 dark:text-muted-foreground',
  },
];

/**
 * Render an app's logo from the canonical APP_REGISTRY. Uses the theme-correct
 * variant when a logo image exists, otherwise falls back to the registered
 * Lucide icon. Sized to fit in a 28x28 cell.
 */
function MemberAppLogo({ appCode, alt }: { appCode: string; alt: string }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const assets = APP_REGISTRY[appCode];
  const logo = assets?.logo;
  const src = logo ? (isDark ? logo.iconDark : logo.iconLight) : undefined;

  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        className={cn('object-contain', logo?.iconClassName || 'h-5 w-5')}
      />
    );
  }

  const FallbackIcon = assets?.lucideIcon ?? PackageIcon;
  return <FallbackIcon className="h-5 w-5 text-muted-foreground" />;
}

interface WorkspaceRoleOption {
  id: string;
  name: string;
  description?: string;
  isSystemRole: boolean;
  memberCount: number;
}

function PermissionsContent({
  member,
  isOwner,
  localRole,
  updatingRole,
  canManageMembers,
  memberApps,
  updatingApps,
  rolePermissions,
  memberOverrides,
  updateMemberMutation,
  context,
  workspaceRoles,
  onRoleChange,
  onAppToggle,
  onMemberUpdated,
}: {
  member: TeamMemberDetail;
  isOwner: boolean;
  localRole: string;
  updatingRole: boolean;
  canManageMembers: boolean;
  memberApps: MemberAppAssignment[];
  updatingApps: Record<string, boolean>;
  rolePermissions: string[];
  memberOverrides: string[];
  updateMemberMutation: ReturnType<typeof useUpdateMember>;
  context: 'settings' | 'projects';
  workspaceRoles: WorkspaceRoleOption[];
  onRoleChange: (role: string) => void;
  onAppToggle: (appCode: string, currentlyAssigned: boolean) => void;
  onMemberUpdated: () => void;
}) {
  const activeRole = isOwner ? 'OWNER' : localRole;
  const [localOverrides, setLocalOverrides] = useState<Set<string>>(new Set(memberOverrides));
  const [savingOverrides, setSavingOverrides] = useState(false);
  const [permSearchOpen, setPermSearchOpen] = useState(false);
  const [permSearchQuery, setPermSearchQuery] = useState('');
  const permSearchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (permSearchOpen) permSearchInputRef.current?.focus();
  }, [permSearchOpen]);

  // Sync local overrides when server data changes
  useEffect(() => {
    setLocalOverrides(new Set(memberOverrides));
  }, [memberOverrides]);

  const isRoleGranted = (permKey: string) => {
    return rolePermissions.some(rp => hasPermission([rp], permKey));
  };

  const toggleOverride = (permKey: string) => {
    setLocalOverrides(prev => {
      const next = new Set(prev);
      if (next.has(permKey)) next.delete(permKey);
      else next.add(permKey);
      return next;
    });
  };

  const toggleAllModuleOverrides = (permissions: { key: string }[], grant: boolean) => {
    setLocalOverrides(prev => {
      const next = new Set(prev);
      for (const p of permissions) {
        if (isRoleGranted(p.key)) continue; // skip already inherited
        if (grant) next.add(p.key);
        else next.delete(p.key);
      }
      return next;
    });
  };

  const hasOverrideChanges = (() => {
    const saved = new Set(memberOverrides);
    if (localOverrides.size !== saved.size) return true;
    for (const k of localOverrides) {
      if (!saved.has(k)) return true;
    }
    return false;
  })();

  const handleSaveOverrides = async () => {
    setSavingOverrides(true);
    try {
      const result = await updateMemberMutation.mutateAsync({
        id: member.id,
        data: { permissions: Array.from(localOverrides) },
      });
      if (result.success) {
        toast.success('Permission overrides saved');
        onMemberUpdated();
      } else {
        toast.error('Failed to save permission overrides');
      }
    } catch {
      toast.error('Failed to save permission overrides');
    } finally {
      setSavingOverrides(false);
    }
  };

  return (
    <div className="px-4 py-10 space-y-10">
      {/* Workspace Role */}
      <div className="w-[848px] max-w-full mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-foreground">
            {context === 'projects' ? 'Project Role' : 'Workspace Role'}
          </h3>
          {updatingRole && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>

        {canManageMembers && !isOwner ? (
          <Select value={localRole} onValueChange={onRoleChange} disabled={updatingRole}>
            <SelectTrigger className="w-44 h-9 text-sm">
              {updatingRole ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <span className="truncate">
                  {(() => {
                    const card = ROLE_CARDS.find((r) => r.value === localRole);
                    if (card) return card.label;
                    const custom = workspaceRoles.find((r) => r.id === localRole);
                    return custom?.name ?? getRoleLabel(localRole);
                  })()}
                </span>
              )}
            </SelectTrigger>
            <SelectContent className="w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)]">
              {ROLE_CARDS.map((role) => (
                <SelectItem key={role.value} value={role.value} className="data-[state=checked]:bg-muted">
                  <span>{role.label}</span>
                </SelectItem>
              ))}
              {workspaceRoles
                .filter((r) => !r.isSystemRole)
                .map((role) => (
                  <SelectItem key={role.id} value={role.id} className="data-[state=checked]:bg-muted">
                    <span>{role.name}</span>
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          <div className={cn(
            'flex items-center gap-3 p-3 rounded-lg border',
            isOwner ? 'border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/20' : 'border-border',
          )}>
            <div className={cn('w-8 h-8 rounded-md flex items-center justify-center', isOwner ? 'bg-purple-500/10' : 'bg-muted')}>
              {isOwner ? (
                <Crown className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              ) : (
                (() => {
                  const card = ROLE_CARDS.find(r => r.value === activeRole);
                  if (card) {
                    const Icon = card.icon;
                    return <Icon className={cn('h-4 w-4', card.color)} />;
                  }
                  // Custom role fallback — no preset icon, use Shield.
                  return <Shield className="h-4 w-4 text-muted-foreground" />;
                })()
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                {(() => {
                  if (isOwner) return 'Owner';
                  const card = ROLE_CARDS.find(r => r.value === activeRole);
                  if (card) return card.label;
                  const custom = workspaceRoles.find((r) => r.id === activeRole);
                  return custom?.name ?? getRoleLabel(activeRole);
                })()}
              </p>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  if (isOwner) return 'Full control including billing & workspace deletion';
                  const card = ROLE_CARDS.find(r => r.value === activeRole);
                  if (card) return card.description;
                  const custom = workspaceRoles.find((r) => r.id === activeRole);
                  return custom?.description ?? 'Custom role';
                })()}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* App Access — settings only */}
      {context === 'settings' && (
        <div className="w-[848px] max-w-full mx-auto border-t border-border/70 pt-10">
          <h3 className="text-sm font-medium text-foreground mb-3">App Access</h3>

          {activeRole === 'OWNER' || activeRole === 'ADMIN' ? (
            <>
              <p className="text-xs text-muted-foreground mb-3">
                Owners and admins automatically have access to every installed app.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {memberApps.map((app) => (
                  <div
                    key={app.appCode}
                    className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border bg-card"
                  >
                    <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                      <MemberAppLogo appCode={app.appCode} alt={app.appName} />
                    </div>
                    <p className="text-sm font-medium flex-1 min-w-0 truncate text-foreground">
                      {app.appName}
                    </p>
                    <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
                      <Switch
                        className="shrink-0"
                        checked={true}
                        disabled={true}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : memberApps.length === 0 ? (
            <p className="text-xs text-muted-foreground">No apps available.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {memberApps.map((app) => {
                return (
                  <div
                    key={app.appCode}
                    className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border bg-card transition-all"
                  >
                    <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                      <MemberAppLogo appCode={app.appCode} alt={app.appName} />
                    </div>
                    <p className="text-sm font-medium flex-1 min-w-0 truncate text-foreground">
                      {app.appName}
                    </p>
                    {canManageMembers ? (
                      <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
                        {updatingApps[app.appCode] && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        )}
                        <Switch
                          className="shrink-0"
                          checked={app.isAssigned}
                          onCheckedChange={() => onAppToggle(app.appCode, app.isAssigned)}
                          disabled={updatingApps[app.appCode]}
                        />
                      </div>
                    ) : (
                      <span className={cn('text-[11px] font-medium flex-shrink-0', app.isAssigned ? 'text-green-600' : 'text-muted-foreground')}>
                        {app.isAssigned ? 'On' : 'Off'}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Per-Member Permission Overrides — settings only */}
      {context === 'settings' && !isOwner && (
        <div className="w-[848px] max-w-full mx-auto border-t border-border/70 pt-10">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-medium text-foreground">Permission Overrides</h3>
            <div className="flex items-center gap-2">
              <div className="relative flex items-center">
                <div
                  className={cn(
                    'flex items-center transition-all duration-200 ease-out',
                    permSearchOpen ? 'w-48' : 'w-8',
                  )}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className={cn(
                      'h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200',
                      permSearchOpen && 'opacity-0 pointer-events-none absolute',
                    )}
                    onClick={() => setPermSearchOpen(true)}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                  <div
                    className={cn(
                      'relative transition-all duration-200 ease-out',
                      permSearchOpen ? 'opacity-100 w-48' : 'opacity-0 w-0 pointer-events-none',
                    )}
                  >
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      ref={permSearchInputRef}
                      type="text"
                      placeholder="Search permissions..."
                      value={permSearchQuery}
                      onChange={(e) => setPermSearchQuery(e.target.value)}
                      onBlur={() => !permSearchQuery && setPermSearchOpen(false)}
                      className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                    />
                  </div>
                </div>
              </div>
              {canManageMembers && hasOverrideChanges && (
                <Button
                  size="sm"
                  className="h-7 text-xs shadow-none"
                  onClick={handleSaveOverrides}
                  disabled={savingOverrides}
                >
                  {savingOverrides ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
                  Save
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground mb-6">
            Grant additional permissions for this member only, beyond their role. Inherited permissions are shown as locked.
          </p>

          <PermissionOverrideTables
            isRoleGranted={isRoleGranted}
            localOverrides={localOverrides}
            canManageMembers={canManageMembers}
            toggleOverride={toggleOverride}
            toggleAllModuleOverrides={toggleAllModuleOverrides}
            inheritedTitle={(perm) => `Inherited from ${getRoleLabel(activeRole)} role — ${perm.label}`}
            searchQuery={permSearchQuery}
          />
        </div>
      )}
    </div>
  );
}

/* ─── Permission Override Tables ──────────────────────────────────── */

type OverridePerm = {
  key: string;
  label: string;
  action: string;
};

function PermissionOverrideTables({
  isRoleGranted,
  localOverrides,
  canManageMembers,
  toggleOverride,
  toggleAllModuleOverrides,
  inheritedTitle,
  searchQuery = '',
}: {
  isRoleGranted: (permKey: string) => boolean;
  localOverrides: Set<string>;
  canManageMembers: boolean;
  toggleOverride: (permKey: string) => void;
  toggleAllModuleOverrides: (perms: { key: string }[], grant: boolean) => void;
  inheritedTitle: (perm: OverridePerm) => string;
  searchQuery?: string;
}) {
  const t = useTranslations();
  const ACTION_LABELS = React.useMemo(() => getActionLabels(t), [t]);
  const rows: CategoryRow<OverridePerm>[] = React.useMemo(() => {
    return PERMISSION_CATALOG_OBJECTS.map((obj) => {
      const perAction: Partial<Record<StandardAction, OverridePerm>> = {};
      const extras: OverridePerm[] = [];
      const allPerms: OverridePerm[] = [];
      for (const p of obj.permissions) {
        const action = p.key.split(':').slice(1).join(':') || 'read';
        const perm: OverridePerm = { key: p.key, label: p.label, action };
        allPerms.push(perm);
        if ((STANDARD_ACTIONS as readonly string[]).includes(action)) {
          perAction[action as StandardAction] = perm;
        } else {
          extras.push(perm);
        }
      }
      return {
        object: obj.key,
        objectName: obj.label,
        category: categoryFor(obj.key),
        perAction,
        extras,
        allPerms,
      };
    });
  }, []);

  const groups: CategoryGroup<OverridePerm>[] = React.useMemo(() => groupByCategory(rows), [rows]);

  const filteredGroups = React.useMemo<CategoryGroup<OverridePerm>[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (row) =>
            row.objectName.toLowerCase().includes(q) ||
            row.object.toLowerCase().includes(q) ||
            group.category.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.rows.length > 0);
  }, [groups, searchQuery]);

  const isGranted = (perm: OverridePerm) => isRoleGranted(perm.key) || localOverrides.has(perm.key);

  const renderCheckbox = (perm: OverridePerm, ariaLabel: string) => {
    const inherited = isRoleGranted(perm.key);
    const granted = isGranted(perm);
    return (
      <Checkbox
        checked={granted}
        onCheckedChange={() => {
          if (!inherited) toggleOverride(perm.key);
        }}
        disabled={inherited || !canManageMembers}
        className={cn('h-3.5 w-3.5', inherited && 'opacity-70')}
        aria-label={ariaLabel}
        title={inherited ? inheritedTitle(perm) : perm.label}
      />
    );
  };

  return (
    <div className="space-y-10">
      {filteredGroups.length === 0 && (
        <p className="text-sm text-muted-foreground w-[848px] max-w-full mx-auto">
          No permissions match &ldquo;{searchQuery}&rdquo;.
        </p>
      )}
      {filteredGroups.map((group) => {
        const allPerms = group.rows.flatMap((r) => r.allPerms);
        const nonInherited = allPerms.filter((p) => !isRoleGranted(p.key));
        const allNonInheritedGranted =
          nonInherited.length > 0 && nonInherited.every((p) => localOverrides.has(p.key));
        const groupHasExtras = group.rows.some((r) => r.extras.length > 0);

        return (
          <div key={group.category} className="space-y-3 w-[848px] max-w-full mx-auto">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h4 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                  <CategoryIcon category={group.category} className="h-4 w-4 shrink-0" />
                  <span>{group.category}</span>
                </h4>
                {COMING_SOON_CATEGORIES.has(group.category) && <ComingSoonBadge />}
              </div>
              {canManageMembers && nonInherited.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-[11px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors whitespace-nowrap"
                  onClick={() => toggleAllModuleOverrides(nonInherited, !allNonInheritedGranted)}
                >
                  {allNonInheritedGranted ? 'Revoke all' : 'Grant all'}
                </Button>
              )}
            </div>
            <div className="rounded-md border border-border/70 overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-background [&_tr]:border-border/70">
                    <TableRow>
                      <TableHead className="w-[220px] text-[13px]">Object</TableHead>
                      {STANDARD_ACTIONS.map((action) => (
                        <TableHead key={action} className="w-[90px] text-center text-[13px]">
                          {ACTION_LABELS[action]}
                        </TableHead>
                      ))}
                      {groupHasExtras && <TableHead className="text-[13px]">Other</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_tr]:border-border/70">
                    {group.rows.map((row) => {
                      const rowNonInherited = row.allPerms.filter((p) => !isRoleGranted(p.key));
                      const rowAllGranted =
                        rowNonInherited.length > 0 &&
                        rowNonInherited.every((p) => localOverrides.has(p.key));
                      return (
                        <TableRow key={row.object} className="h-10 hover:bg-muted/30">
                          <TableCell className="py-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium">{row.objectName}</span>
                              {canManageMembers && rowNonInherited.length > 0 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  className="text-[11px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors whitespace-nowrap"
                                  onClick={() =>
                                    toggleAllModuleOverrides(rowNonInherited, !rowAllGranted)
                                  }
                                >
                                  {rowAllGranted ? 'Revoke all' : 'Grant all'}
                                </Button>
                              )}
                            </div>
                          </TableCell>

                          {STANDARD_ACTIONS.map((action) => {
                            const perm = row.perAction[action];
                            return (
                              <TableCell
                                key={action}
                                className="py-2 px-3 text-center [&:has([role=checkbox])]:pr-3 [&:has([role=checkbox])]:pl-3"
                              >
                                <div className="flex items-center justify-center">
                                  {perm ? (
                                    renderCheckbox(perm, `${ACTION_LABELS[action]} ${row.objectName}`)
                                  ) : (
                                    <span className="text-muted-foreground/40 text-sm tabular-nums select-none">
                                      —
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                            );
                          })}

                          {groupHasExtras && (
                            <TableCell className="py-2">
                              {row.extras.length > 0 ? (
                                <div className="flex flex-wrap gap-x-4 gap-y-1">
                                  {row.extras.map((perm) => (
                                    <label
                                      key={perm.key}
                                      className={cn(
                                        'flex items-center gap-1.5 text-sm',
                                        canManageMembers && !isRoleGranted(perm.key)
                                          ? 'cursor-pointer'
                                          : 'cursor-default',
                                      )}
                                    >
                                      {renderCheckbox(perm, perm.action)}
                                      <span className="text-muted-foreground capitalize">
                                        {perm.action.replace(/-/g, ' ')}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              ) : null}
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Collapsed Header Additions ───────────────────────────────────── */

function MemberHeaderIdentity({ member }: { member: TeamMemberDetail }) {
  const { getStatus } = usePresence();
  const profileQuery = useMemberProfile(member.userId || undefined);

  const presence = getStatus(member.userId ?? '');
  const status = (presence?.status ?? 'offline') as PresenceStatus;
  const statusLabel = presence?.statusText || STATUS_LABELS[status] || 'Offline';

  const title = profileQuery.data?.title ?? null;

  return (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      <div className="relative flex-shrink-0">
        {member.avatar ? (
          <img
            src={member.avatar}
            alt={member.name ?? ''}
            className="w-7 h-7 rounded-lg object-cover"
          />
        ) : (
          <div className="w-7 h-7 rounded-lg bg-purple-100 dark:bg-purple-900 flex items-center justify-center">
            <User className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          </div>
        )}
        {member.userId && (
          <StatusDot
            status={status}
            size="lg"
            className="!h-[11px] !w-[11px] absolute -bottom-0.5 -right-0.5 border-background"
          />
        )}
      </div>
      <div className="flex flex-col min-w-0 leading-tight">
        <h1 className="text-[15px] font-medium text-foreground truncate max-w-[200px]">
          {member.name || 'Unknown'}
        </h1>
        {title && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground truncate max-w-[220px]">
            <span className="truncate">{title}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MemberCallButtons({ userId }: { userId?: string | null }) {
  const dmQuery = useDmByUser(userId ?? '');
  const { startCall, status: callStatus } = useWeldChatCall();
  const dmChannelId: string | undefined = dmQuery.data?.data?.id;
  const inCall = callStatus !== 'idle' && callStatus !== 'ended';

  if (!userId) return null;

  const handleCall = async (kind: 'voice' | 'video') => {
    if (!dmChannelId) {
      toast.error('Unable to start call — no DM channel yet.');
      return;
    }
    if (inCall) {
      toast.error('You are already in a call.');
      return;
    }
    try {
      await startCall(dmChannelId, kind);
    } catch (err) {
      toast.error('Failed to start call');
      console.error(err);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="p-1.5 hover:bg-muted rounded-md transition-colors disabled:opacity-50"
        title="Voice call"
        onClick={() => handleCall('voice')}
        disabled={!dmChannelId || inCall}
      >
        <Phone className="h-4 w-4 text-gray-500" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="p-1.5 hover:bg-muted rounded-md transition-colors disabled:opacity-50"
        title="Video call"
        onClick={() => handleCall('video')}
        disabled={!dmChannelId || inCall}
      >
        <Video className="h-[19px] w-[19px] text-gray-500" strokeWidth={1.75} />
      </Button>
    </>
  );
}

/* ─── Collapsed Tab Content Router ────────────────────────────────── */

function buildCollapsedTabs({
  hideMessages, canViewActivity, showPermissions,
}: { hideMessages?: boolean; canViewActivity: boolean; showPermissions?: boolean }): PageTab[] {
  const tabs = hideMessages ? baseTabItems.filter((t) => t.id !== 'messages') : [...baseTabItems];
  if (canViewActivity) tabs.push(activityTabItem);
  if (showPermissions) tabs.push({ id: 'permissions', label: 'Permissions', icon: Shield });
  return tabs;
}

function CollapsedTabContent({
  tab, member, hideMessages, canViewActivity,
}: {
  tab: MemberTab;
  member: TeamMemberDetail;
  hideMessages?: boolean;
  canViewActivity: boolean;
}) {
  // With hideMessages, treat 'messages' as 'profile' (tab is filtered out of the bar)
  const effective: MemberTab = hideMessages && tab === 'messages' ? 'profile' : tab;

  if (effective === 'messages') {
    if (!member.userId) {
      return (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          No user ID available for direct messaging
        </div>
      );
    }
    return <EmbeddedDmChat targetUserId={member.userId} />;
  }

  if (!member.userId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No user ID available
      </div>
    );
  }

  return (
    <MemberProfileTabs
      tab={effective}
      userId={member.userId}
      canViewActivity={canViewActivity}
    />
  );
}

function MemberProfileTabs({
  tab, userId, canViewActivity,
}: {
  tab: MemberTab;
  userId: string;
  canViewActivity: boolean;
}) {
  const { userId: viewerUserId } = useAuth();
  const profileQuery = useMemberProfile(userId);
  const isSelf = !!viewerUserId && viewerUserId === userId;

  if (tab === 'activity') {
    // Self can always view own activity; admins can view anyone's.
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <MemberActivityTab userId={userId} canView={canViewActivity || isSelf} />
      </div>
    );
  }

  if (profileQuery.isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (!profileQuery.data) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Member not found.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {tab === 'profile' && <MemberOverviewTab profile={profileQuery.data} />}
      {tab === 'common' && <MemberCommonTab userId={userId} isSelf={isSelf} />}
    </div>
  );
}

function MemberWorkingHoursContent({ memberId, memberName: _memberName }: { memberId: string; memberName: string | null }) {
  const { data: workingHours, isLoading } = useMemberWorkingHours(memberId);
  const updateMemberWorkingHours = useUpdateMemberWorkingHours();
  const [hours, setHours] = useState<WorkingHours>(DEFAULT_HOURS);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (workingHours) setHours(workingHours);
  }, [workingHours]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleChange = (next: WorkingHours) => {
    setHours(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        await updateMemberWorkingHours.mutateAsync({ memberId, workingHours: next });
      } catch {
        toast.error('Failed to update working hours');
      }
    }, 500);
  };

  return (
    <div className="px-4 py-10">
      <div className="w-fit max-w-full mx-auto">
        <div className="mb-4">
          <h3 className="text-base font-semibold">Working Hours</h3>
          <p className="text-sm text-muted-foreground">
            Set when this member is available for automatic task scheduling.
          </p>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <WorkingHoursEditor value={hours} onChange={handleChange} />
        )}
      </div>
    </div>
  );
}
