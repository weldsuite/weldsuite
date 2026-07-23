import {
  useState,
  useRef,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { usePathname } from '@/lib/router';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useWorkspaceMembers, weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { TeamMemberDetailsPanel, fromTeamMember, type TeamMemberDetail } from '@/components/team-member-details-panel';
import { AgentProfilePanel } from './agent-profile-panel';
import { ChatHeader } from './chat-header';
import { MemberListPanel } from './member-list-panel';
import { PinnedMessagesPanel } from './pinned-messages-panel';
import { ThreadPanel } from './thread-panel';
import { BookmarksPanel } from './bookmarks-panel';
import { ChatFiltersPanel } from './chat-filters-panel';
import { useChannel } from '@/hooks/queries/use-weldchat-queries';
import { ChatContext, type RightPanel, type ReplyTo, type ChatFilters } from './chat-context';
import { useCalendarDrawerOpen } from '@/hooks/use-calendar-drawer-open';
import { useNotificationsPanelOpen } from '@/hooks/use-notifications-panel-open';
import { useWeldAgentDrawerOpen } from '@/hooks/use-weldagent-drawer-open';
import { useEntitySheet } from '@/components/entity-sheet/use-entity-sheet';
import { useObjectPanel } from '@/components/object-panel';
import { ModuleContent } from '@/components/layout/module-content';
export { useChatContext, type ReplyTo } from './chat-context';

export function ChatLayoutClient({ children }: { children: ReactNode }) {
  const t = getTranslations('weldchat');
  const st = useTranslations();
  const pathname = usePathname();

  // Extract channelId from URL for right panel components.
  // The first path segment after `/weldchat/` is treated as a channel id UNLESS
  // it's one of the reserved sibling routes (activity, drafts, directories,
  // bookmarks, search, thread, …). Those don't represent a real channel and
  // shouldn't trigger the members / entity panels.
  const RESERVED_TOP_SEGMENTS = new Set([
    'activity',
    'drafts',
    'directories',
    'bookmarks',
    'search',
    'thread',
  ]);
  const channelIdMatch = pathname?.match(/\/weldchat\/([^/]+)/);
  const dmMatch = pathname?.match(/\/weldchat\/dm\/([^/]+)/);
  const rawChannelSegment = channelIdMatch?.[1] ?? '';
  const isReservedRoute = RESERVED_TOP_SEGMENTS.has(rawChannelSegment);
  const currentChannelId =
    dmMatch?.[1] || (!isReservedRoute ? rawChannelSegment : '') || '';
  const isChannelPage = !!rawChannelSegment && !isReservedRoute && !dmMatch?.[1];

  // Initial value picked by the effect below once the current channel has
  // been fetched — entity channels default to the linked-entity view, normal
  // channels default to the member list.
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [filters, setFilters] = useState<ChatFilters>({ type: 'all', search: '', from: [], date: undefined });
  const [selectedProfileUserId, setSelectedProfileUserId] = useState<string | null>(null);
  const [selectedAgentProfileId, setSelectedAgentProfileId] = useState<string | null>(null);
  // Skip the slide-in animation when one panel is opened on top of another
  // (panel → panel swaps should be instant). Reset to false on close so a
  // fresh open animates normally.
  const [skipProfilePanelAnim, setSkipProfilePanelAnim] = useState(false);

  const { data: currentChannelData } = useChannel(
    isChannelPage ? currentChannelId : '',
  );
  const currentChannel: any = currentChannelData?.data;

  // Clear any stale 'members' rail-panel selection when the channel
  // changes — the unified ChannelPanel auto-open is handled in a separate
  // effect below.
  useEffect(() => {
    setRightPanel((prev) => (prev === 'members' ? null : prev));
  }, [isChannelPage, currentChannelId]);

  // Auto-open the global ChannelPanel on every desktop channel page. Track
  // the last channelId we opened for in a ref so we only auto-open ONCE per
  // channel — that way the user's manual close (via the panel's X button or
  // header toggle) is honored until they navigate to a different channel.
  // The open is deferred via setTimeout because `ObjectPanelHost` runs a
  // `closeAll()` on every pathname change AFTER our useEffect, which would
  // otherwise close the panel we just opened.
  const { open: openObjectPanel, closeAll: closeAllObjectPanels, stack: objectPanelStack } = useObjectPanel();
  const autoOpenedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isChannelPage || !currentChannelId) {
      autoOpenedForRef.current = null;
      return;
    }
    const isMobileViewport =
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 767px)').matches;
    if (isMobileViewport) return;
    if (autoOpenedForRef.current === currentChannelId) return;
    autoOpenedForRef.current = currentChannelId;
    const tid = setTimeout(() => {
      openObjectPanel({ type: 'channel', id: currentChannelId, initialTab: 'people' });
    }, 0);
    return () => clearTimeout(tid);
  }, [isChannelPage, currentChannelId, openObjectPanel]);

  // The ChannelPanel lives in the GLOBAL object-panel stack (rendered by
  // <ObjectPanelHost /> at the app-shell level), so without this it survives
  // navigation OUT of WeldChat and keeps appearing across the whole platform.
  // Scope its lifecycle to the WeldChat layout — exactly like the WeldAgent
  // panel, which unmounts with its module layout — by clearing the stack when
  // this layout unmounts (the user has left WeldChat entirely). Channel→channel
  // and channel→other-WeldChat-page navigation keeps this component mounted, so
  // this cleanup does NOT fire there (those cases are handled by the auto-open
  // effect above and ObjectPanelHost's own pathname close).
  useEffect(() => {
    return () => {
      closeAllObjectPanels();
    };
  }, [closeAllObjectPanels]);

  const { isOpen: isEntitySheetOpen, view: entitySheetView } = useEntitySheet();
  // Width reserved by the entity sheet on the right edge (default view only —
  // 'full' view covers the whole content area so shrinking is meaningless).
  const entitySheetWidth = isEntitySheetOpen && entitySheetView !== 'full' ? 500 : 0;

  const { status: callStatus, channelId: callChannelId, isFullscreen: callFullscreen, isPiP: callPiP } = useWeldChatCall();
  const isInlineCall = callStatus !== 'idle' && callStatus !== 'ended' && callChannelId === currentChannelId && !callFullscreen && !callPiP;

  const mobileNav = useMobileNavOptional();
  const [showWeldAgent, setShowWeldAgentDirect] = useWeldAgentDrawerOpen();
  const setShowWeldAgent = mobileNav?.setShowWeldAgent ?? setShowWeldAgentDirect;

  const [showCalendar, setShowCalendar] = useCalendarDrawerOpen();
  const [showNotifications, setShowNotifications] = useNotificationsPanelOpen();

  // Pre-read localStorage to know if the member detail panel should be open on mount
  const isDmPage = !!dmMatch?.[1];
  const isIndividualDmPage = isDmPage && dmMatch?.[1] !== 'group';
  const dmPanelSavedOpen = isDmPage && localStorage.getItem('weldchat-dm-member-panel') !== 'false';
  const [memberDetailWidth, setMemberDetailWidth] = useState(dmPanelSavedOpen ? 480 : 0);

  // Track whether transitions should be enabled.
  // Disabled until the first user-driven panel toggle to prevent any load animation.
  const hasUserToggled = useRef(false);
  const [enableTransitions, setEnableTransitions] = useState(false);

  const weldAgentWidth = mobileNav?.weldAgentWidth ?? 480;
  const calendarWidth = 480;
  const notificationsWidth = 480;

  // Listen for member-detail-panel events to adjust content width
  useEffect(() => {
    const handler = (e: Event) => {
      const { isOpen, width } = (e as CustomEvent).detail;
      const newWidth = isOpen ? width : 0;

      // If user hasn't toggled yet and we already have the right width, ignore
      if (!hasUserToggled.current && newWidth === memberDetailWidth) return;

      // If user hasn't toggled, skip events that would fight our pre-set width
      if (!hasUserToggled.current) {
        // Only accept if it matches what we expect (open → 480, closed → 0)
        if (dmPanelSavedOpen && newWidth === 0) return; // ignore close events during load
      }

      setMemberDetailWidth(newWidth);
    };
    window.addEventListener('member-detail-panel', handler);
    return () => window.removeEventListener('member-detail-panel', handler);
  }, [dmPanelSavedOpen, memberDetailWidth]);

  // Mark that transitions can be enabled after user interacts
  useEffect(() => {
    const handler = () => {
      if (!hasUserToggled.current) {
        hasUserToggled.current = true;
        setEnableTransitions(true);
      }
    };
    window.addEventListener('member-detail-panel-user-toggle', handler);
    return () => window.removeEventListener('member-detail-panel-user-toggle', handler);
  }, []);

  // The entity sheet is the active panel — enforce the one-panel rule by
  // hiding the chat's own right panel for the duration. Derived (not state),
  // so the close + outer width change + sheet slide-in all happen in the same
  // render frame — no useEffect round-trip, no flash. `rightPanel` state is
  // preserved untouched so the previous panel automatically returns when the
  // sheet closes.
  const effectiveRightPanel: RightPanel = isEntitySheetOpen ? null : rightPanel;

  // First time the entity sheet open state changes after mount, enable the
  // width transition so subsequent open/close animates instead of snapping.
  const isFirstSheetTickRef = useRef(true);
  useEffect(() => {
    if (isFirstSheetTickRef.current) {
      isFirstSheetTickRef.current = false;
      return;
    }
    if (!hasUserToggled.current) {
      hasUserToggled.current = true;
      setEnableTransitions(true);
    }
  }, [isEntitySheetOpen]);

  // Entity sheet (customer / order / task / … detail) and the member-detail
  // panel both float over the chat content — letting them coexist stacks two
  // overlays on top of each other. When the entity sheet opens (e.g. user
  // clicked an `@customer` mention), close the member/agent profile panels so
  // only the entity sheet remains visible.
  useEffect(() => {
    if (isEntitySheetOpen) {
      setSelectedProfileUserId(null);
      setSelectedAgentProfileId(null);
    }
  }, [isEntitySheetOpen]);

  // Detect the render where the entity sheet toggles, so we can suppress the
  // chat content's `transition-[width]` for that one paint. Otherwise the
  // 200ms width tween fights the snap swap from members panel ↔ entity sheet
  // and the user sees a brief slide. Ref is updated AFTER the render so the
  // toggle render reads the previous value.
  const prevSheetOpenRef = useRef(isEntitySheetOpen);
  const sheetTogglingThisRender = prevSheetOpenRef.current !== isEntitySheetOpen;
  useEffect(() => {
    prevSheetOpenRef.current = isEntitySheetOpen;
  }, [isEntitySheetOpen]);

  // Same idea for route changes: when the user navigates between weldchat
  // pages (e.g. customer entity-sheet view → channel with members panel) the
  // content area's width can shift, and the 200ms tween makes it look like
  // the panel is sliding in from the side. Suppress the transition for the
  // single render where pathname changes so the swap is instant.
  const prevPathnameRef = useRef(pathname);
  const pathnameChangingThisRender = prevPathnameRef.current !== pathname;
  useEffect(() => {
    prevPathnameRef.current = pathname;
  }, [pathname]);

  // Always emit a single calc() form — CSS can't smoothly animate between
  // '100%' and 'calc(100% - Npx)' (different unit forms), which is why the
  // width change felt janky. calc(100% - 0px) collapses cleanly to 100%.
  const getContentWidth = () => {
    let total = 0;
    if (showWeldAgent) total += weldAgentWidth;
    if (showCalendar) total += calendarWidth;
    if (showNotifications) total += notificationsWidth;
    if (memberDetailWidth) total += memberDetailWidth;
    if (entitySheetWidth) total += entitySheetWidth;
    // Object-panel host writes its reservation onto the CSS var; subtract it
    // so the chat content shrinks when the ChannelPanel slides in.
    return `calc(100% - ${total}px - var(--object-panel-reservation-width, 0px))`;
  };

  const openThread = useCallback((messageId: string) => {
    setThreadMessageId(messageId);
    setRightPanel('thread');
  }, []);
  const closeThread = useCallback(() => {
    setThreadMessageId(null);
    setRightPanel(null);
  }, []);
  const openUserProfile = useCallback((userId: string) => {
    // Only one side panel is visible at a time. Close any open object
    // panel (channel panel, etc.) before opening the user profile so they
    // don't stack on top of each other.
    const wasAnotherPanelOpen =
      objectPanelStack.length > 0 || selectedProfileUserId !== null || selectedAgentProfileId !== null;
    setSkipProfilePanelAnim(wasAnotherPanelOpen);
    closeAllObjectPanels();
    window.dispatchEvent(new CustomEvent('member-detail-panel-user-toggle'));
    setSelectedProfileUserId(userId);
    setSelectedAgentProfileId(null);
  }, [closeAllObjectPanels, objectPanelStack.length, selectedProfileUserId, selectedAgentProfileId]);
  const closeUserProfile = useCallback(() => {
    setSelectedProfileUserId(null);
    setSkipProfilePanelAnim(false);
  }, []);
  const openAgentProfile = useCallback((agentId: string) => {
    const wasAnotherPanelOpen =
      objectPanelStack.length > 0 || selectedProfileUserId !== null || selectedAgentProfileId !== null;
    setSkipProfilePanelAnim(wasAnotherPanelOpen);
    closeAllObjectPanels();
    setSelectedAgentProfileId(agentId);
    setSelectedProfileUserId(null);
  }, [closeAllObjectPanels, objectPanelStack.length, selectedProfileUserId, selectedAgentProfileId]);
  const closeAgentProfile = useCallback(() => {
    setSelectedAgentProfileId(null);
    setSkipProfilePanelAnim(false);
  }, []);

  // Clear the selected profile when navigating between channels/DMs
  useEffect(() => {
    setSelectedProfileUserId(null);
    setSelectedAgentProfileId(null);
  }, [currentChannelId]);

  // Resolve selected user → TeamMemberDetail. Individual DM pages manage
  // their own panel, so skip there to avoid overlapping panels.
  const { data: workspaceMembersData } = useWorkspaceMembers();
  const queryClient = useQueryClient();
  const profileMember: TeamMemberDetail | null = useMemo(() => {
    if (!selectedProfileUserId || isIndividualDmPage) return null;
    const all = workspaceMembersData?.data || [];
    const found = all.find((m: any) => m.userId === selectedProfileUserId);
    return found ? fromTeamMember(found) : null;
  }, [selectedProfileUserId, isIndividualDmPage, workspaceMembersData]);

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' }]}>
      <ChatContext.Provider
        value={{
          activeChannelId,
          setActiveChannelId,
          rightPanel,
          setRightPanel,
          threadMessageId,
          openThread,
          closeThread,
          replyTo,
          setReplyTo,
          filters,
          setFilters,
          selectedProfileUserId,
          openUserProfile,
          closeUserProfile,
          selectedAgentProfileId,
          openAgentProfile,
          closeAgentProfile,
        }}
      >
        <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
          <ChatHeader />

          <ModuleContent>
            <div className="flex flex-1 min-w-0 h-full overflow-hidden">
              <div className="flex-1 min-w-0 flex flex-col">{children}</div>

              {effectiveRightPanel && currentChannelId && !isInlineCall &&
                (!isDmPage || effectiveRightPanel === 'bookmarks' || effectiveRightPanel === 'filters') && (
                <div className="max-md:fixed max-md:inset-0 max-md:z-40 max-md:bg-background max-md:flex max-md:flex-col md:w-[480px] md:flex-shrink-0 md:border-l h-full overflow-hidden">
                  {/* Mobile-only close bar. On md+ this is hidden because each
                      panel has its own internal header / close affordance. */}
                  <div className="md:hidden flex items-center justify-end px-2 py-2 border-b flex-shrink-0">
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => {
                        if (effectiveRightPanel === 'thread') {
                          closeThread();
                        } else {
                          setRightPanel(null);
                        }
                      }}
                      aria-label={t.closePanel}
                      className="p-2 -m-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                    </Button>
                  </div>
                  {/* `md:contents` removes this wrapper on desktop so the
                      original layout (children direct inside the 480px box)
                      is preserved. On mobile, flex-1/min-h-0/overflow-hidden
                      makes the panel fill the remaining height below the
                      close bar. */}
                  <div className="max-md:flex-1 max-md:min-h-0 max-md:overflow-hidden md:contents">
                    {effectiveRightPanel === 'members' && <MemberListPanel channelId={currentChannelId} />}
                    {effectiveRightPanel === 'pinned' && <PinnedMessagesPanel channelId={currentChannelId} />}
                    {effectiveRightPanel === 'bookmarks' && <BookmarksPanel />}
                    {effectiveRightPanel === 'filters' && <ChatFiltersPanel />}
                    {effectiveRightPanel === 'thread' && threadMessageId && (
                      <ThreadPanel channelId={currentChannelId} messageId={threadMessageId} />
                    )}
                  </div>
                </div>
              )}
            </div>
          </ModuleContent>
        </div>

        {profileMember && (
          <TeamMemberDetailsPanel
            member={profileMember}
            isOpen
            onClose={closeUserProfile}
            canManageMembers={false}
            onRemoveMember={() => {}}
            onMemberUpdated={() =>
              queryClient.invalidateQueries({ queryKey: weldchatKeys.workspaceMembers() })
            }
            context="settings"
            skipAnimation={skipProfilePanelAnim}
          />
        )}

        {selectedAgentProfileId && (
          <AgentProfilePanel
            agentId={selectedAgentProfileId}
            isOpen
            onClose={closeAgentProfile}
            skipAnimation={skipProfilePanelAnim}
          />
        )}
      </ChatContext.Provider>
    </BreadcrumbProvider>
  );
}
