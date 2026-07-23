/**
 * HelpdeskWidget — Main widget component (refactored).
 *
 * Responsibilities:
 *   - Provider mounting (config, customer)
 *   - View routing (home, chat, faq, etc.)
 *   - Widget open/close/animation
 *   - Launcher button
 *
 * All conversation logic lives in ChatView → useConversation.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { ZapietHomeView } from './home-view';
import { MessagesView } from './messages-view';
import { StatusView } from './status-view';
import { FAQView } from './faq-view';
import { ChangelogView } from './changelog-view';
import { NewsView } from './news-view';
import { FeedbackView } from './feedback-view';
import { AppointmentsView } from './appointments-view';
import { AnnouncementsView } from './announcements-view';
import { EventsView } from './events-view';
import { ParcelTrackingView } from './parcel-tracking-view';
import { ConversationHistoryView } from './conversation-history-view';
import { TicketStatusView } from './ticket-status-view';
import { TicketCreateView } from './ticket-create-view';
import { Launcher } from './chat';
import { getStoredConversationIds } from '@/lib/utils/conversation-storage';
import { platformApi } from '@/lib/api/client';
import { ChatView } from './chat/chat-view';
import { WidgetErrorBoundary } from './error-boundary';
import { WidgetConfigProvider, type WidgetThemeSettings } from '@/providers/widget-config-provider';
import { CustomerProvider } from '@/providers/customer-provider';
import { useViewRouter, type WidgetView, resolveView } from '@/hooks/use-view-router';
import { useMobileDetection } from '@/hooks/use-mobile-detection';
import type { PageConfig, OpenWelcomeWorkflow, OpenTeam, OpenContact, OpenConversation } from '@/lib/api/types';

// ============================================================================
// Props
// ============================================================================

interface HelpdeskWidgetProps {
  widgetId: string;
  workspaceId?: string;
  mode?: 'launcher' | 'widget';
  testMode?: boolean;
  parentOrigin?: string;
  defaultOpen?: boolean;
  enabledPages?: string[];
  pageConfigs?: PageConfig[];
  themeSettings?: WidgetThemeSettings;
  disableBackNavigation?: boolean;
  customerEmail?: string;
  customerName?: string;
  showBranding?: boolean;
  replyTimeText?: string;
  isWithinOfficeHours?: boolean;
  nextOpenTime?: string | null;
  officeHoursTimezone?: string | null;
  officeHours?: Record<string, { isOpen: boolean; openTime?: string; closeTime?: string }> | null;
  welcomeWorkflow?: OpenWelcomeWorkflow | null;
  botAgent?: { name: string; avatarUrl: string | null } | null;
  team?: OpenTeam;
  contact?: OpenContact | null;
  conversations?: OpenConversation[];
  initialUnreadCount?: number;
  realtimeUrl?: string;
}

// ============================================================================
// Component
// ============================================================================

export function HelpdeskWidget({
  widgetId,
  workspaceId,
  mode = 'widget',
  testMode,
  parentOrigin,
  defaultOpen = false,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking', 'tickets'],
  pageConfigs,
  themeSettings,
  disableBackNavigation = false,
  customerEmail,
  customerName,
  showBranding,
  replyTimeText,
  isWithinOfficeHours,
  nextOpenTime,
  officeHoursTimezone,
  officeHours,
  welcomeWorkflow,
  botAgent,
  team,
  contact,
  conversations: initialConversations,
  initialUnreadCount,
  realtimeUrl,
}: HelpdeskWidgetProps) {
  // Launcher mode — just render the button
  if (mode === 'launcher') {
    return <Launcher parentOrigin={parentOrigin} launcherColor={themeSettings?.launcherColor} />;
  }

  const startingPage = (themeSettings?.startingPage || 'home').toLowerCase();
  const effectiveEnabledPages = pageConfigs
    ? pageConfigs.filter(p => p.enabled).sort((a, b) => a.order - b.order).map(p => p.id)
    : enabledPages;

  // Detect embed mode
  const isEmbedded = typeof window !== 'undefined' && window.parent !== window;
  const isMobile = useMobileDetection();

  // In embedded mode, start directly in chat view (welcome flow triggers there).
  // In standalone mode, use the configured starting page.
  const initialView = isEmbedded ? 'chat' : startingPage;
  const { currentView, navigate, goBack } = useViewRouter(initialView);

  // Widget visibility — in embedded mode, always start visible
  const [isWidgetHidden, setIsWidgetHidden] = useState(isEmbedded ? false : !defaultOpen);
  const [isClosing, setIsClosing] = useState(false);
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const hasPlayedOpenAnimation = useRef(false);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount ?? 0);

  // Conversation ID for chat view (can be set from history/messages views)
  const [chatConversationId, setChatConversationId] = useState<string | null>(null);

  // Signal to parent SDK that the widget iframe is ready
  useEffect(() => {
    if (isEmbedded) {
      window.parent.postMessage({
        type: 'weld:ready',
        origin: 'widget',
        timestamp: Date.now(),
        id: `weld:ready_${Date.now()}_widget`,
        payload: { iframe: 'widget', ready: true },
      }, parentOrigin || '*');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-restore last active conversation on mount
  useEffect(() => {
    const storedIds = getStoredConversationIds(widgetId);
    if (storedIds.length === 0) return;

    platformApi.getConversationsBulk(storedIds).then(({ conversations }) => {
      // Find most recent active conversation from DB
      const active = conversations
        .filter((c) => c.status !== 'closed' && c.status !== 'resolved')
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

      if (active[0]) {
        setChatConversationId(active[0].id);
      }
    }).catch(() => {
      // API unavailable — skip restore
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open to starting page
  useEffect(() => {
    if (defaultOpen) {
      const view = resolveView(startingPage);
      if (view !== 'home') navigate(view);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ========================================================================
  // Navigation handlers
  // ========================================================================

  const closeAllViews = useCallback(() => {
    setIsWidgetHidden(true);
    setIsClosing(false);
    hasPlayedOpenAnimation.current = false;
    if (isEmbedded) {
      window.parent?.postMessage({ type: 'weld:close' }, parentOrigin || '*');
    }
  }, [isEmbedded, parentOrigin]);

  const showWidget = useCallback(() => {
    setIsWidgetHidden(false);
    setIsClosing(false);
  }, []);

  const openChat = useCallback((conversationId?: string, startNew?: boolean) => {
    if (startNew) {
      setChatConversationId(null);
    } else if (conversationId) {
      setChatConversationId(conversationId);
    }
    navigate('chat');
  }, [navigate]);

  const navigateToView = useCallback((view: WidgetView) => {
    navigate(view);
    setIsWidgetHidden(false);
  }, [navigate]);

  // Build navigation handlers for view components
  const makeNavHandlers = useCallback(() => ({
    onClose: closeAllViews,
    onNavigateHome: () => navigate('home'),
    onNavigateMessages: () => navigate('messages'),
    onNavigateStatus: () => navigate('status'),
    onNavigateFAQ: () => navigate('faq'),
    onNavigateChangelog: () => navigate('changelog'),
    onNavigateNews: () => navigate('news'),
    onNavigateFeedback: () => navigate('feedback'),
    onNavigateAppointments: () => navigate('appointments'),
    onNavigateAnnouncements: () => navigate('announcements'),
    onNavigateEvents: () => navigate('events'),
    onNavigateParcelTracking: () => navigate('parcel-tracking'),
    onNavigateTickets: () => navigate('tickets'),
  }), [navigate, closeAllViews]);

  // ========================================================================
  // Container styling
  // ========================================================================

  const containerStyle: React.CSSProperties = isEmbedded
    ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }
    : {};

  const isAnyViewOpen = !isWidgetHidden;

  // ========================================================================
  // Render
  // ========================================================================

  const nav = makeNavHandlers();

  return (
    <WidgetConfigProvider
      widgetId={widgetId}
      workspaceId={workspaceId}
      themeSettings={themeSettings}
      enabledPages={effectiveEnabledPages}
      pageConfigs={pageConfigs}
      showBranding={showBranding}
      disableBackNavigation={disableBackNavigation}
      parentOrigin={parentOrigin}
      replyTimeText={replyTimeText}
      isWithinOfficeHours={isWithinOfficeHours}
      nextOpenTime={nextOpenTime}
      officeHoursTimezone={officeHoursTimezone}
      officeHours={officeHours}
      botAgent={botAgent}
      team={team}
      welcomeWorkflow={welcomeWorkflow}
    >
      <CustomerProvider
        widgetId={widgetId}
        initialEmail={customerEmail}
        initialName={customerName}
        contact={contact}
      >
        <WidgetErrorBoundary>
          <div
            style={{ ...containerStyle, ...(isWidgetHidden ? { display: 'none' } : {}) }}
            className={isEmbedded ? 'embedded-mode' : ''}
          >
            {/* ============================================================ */}
            {/* Views — only the current view renders                         */}
            {/* ============================================================ */}

            {currentView === 'chat' && (
              <ChatView
                initialConversationId={chatConversationId}
                realtimeUrl={realtimeUrl}
                onBack={() => {
                  if (!goBack()) navigate('messages');
                }}
                onClose={closeAllViews}
                onConversationCreated={(id) => setChatConversationId(id)}
              />
            )}

            {(currentView === 'home' || currentView === 'messages') && (
              <MessagesView
                widgetId={widgetId}
                {...nav}
                onOpenChat={() => openChat(undefined, true)}
                onSelectConversation={(id: string) => openChat(id)}
                enabledPages={effectiveEnabledPages}
              />
            )}

            {currentView === 'faq' && <FAQView {...nav} enabledPages={effectiveEnabledPages} />}
            {currentView === 'status' && <StatusView {...nav} enabledPages={effectiveEnabledPages} />}
            {currentView === 'changelog' && <ChangelogView {...nav} enabledPages={effectiveEnabledPages} />}
            {currentView === 'news' && <NewsView {...nav} enabledPages={effectiveEnabledPages} />}
            {currentView === 'feedback' && <FeedbackView {...nav} enabledPages={effectiveEnabledPages} />}
            {currentView === 'appointments' && <AppointmentsView {...nav} enabledPages={effectiveEnabledPages} />}
            {currentView === 'announcements' && <AnnouncementsView {...nav} enabledPages={effectiveEnabledPages} />}
            {currentView === 'events' && <EventsView {...nav} enabledPages={effectiveEnabledPages} />}
            {currentView === 'parcel-tracking' && <ParcelTrackingView {...nav} enabledPages={effectiveEnabledPages} />}

            {currentView === 'tickets' && (
              <TicketStatusView
                widgetId={widgetId}
                customerEmail={customerEmail}
                onClose={closeAllViews}
                onBack={() => goBack()}
                onCreateTicket={() => navigate('ticket-create')}
              />
            )}

            {currentView === 'ticket-create' && (
              <TicketCreateView
                widgetId={widgetId}
                customerEmail={customerEmail}
                customerName={customerName}
                onClose={closeAllViews}
                onBack={() => navigate('tickets')}
                onTicketCreated={() => navigate('tickets')}
              />
            )}

            {currentView === 'history' && (
              <ConversationHistoryView
                widgetId={widgetId}
                currentConversationId={chatConversationId || undefined}
                onClose={closeAllViews}
                onSelectConversation={(id: string) => openChat(id)}
                onStartNewConversation={() => openChat(undefined, true)}
              />
            )}
          </div>

          {/* Launcher button (standalone mode only) */}
          {!isEmbedded && !(isMobile && isAnyViewOpen) && (
            <Launcher
              isOpen={isAnyViewOpen}
              unreadCount={unreadCount}
              onClick={() => {
                if (isAnyViewOpen) {
                  closeAllViews();
                } else {
                  showWidget();
                  // Navigate to starting page
                  const view = resolveView(startingPage);
                  navigate(view === 'home' ? 'home' : view);
                }
              }}
              launcherColor={themeSettings?.launcherColor}
            />
          )}
        </WidgetErrorBoundary>
      </CustomerProvider>
    </WidgetConfigProvider>
  );
}
