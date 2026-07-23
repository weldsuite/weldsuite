/**
 * useViewRouter — Replaces 13 boolean view flags with a single state machine.
 *
 * Manages: currentView, navigation history (for back button), transitions.
 */

import { useState, useCallback, useRef } from 'react';

export type WidgetView =
  | 'home'
  | 'chat'
  | 'messages'
  | 'history'
  | 'faq'
  | 'status'
  | 'changelog'
  | 'news'
  | 'feedback'
  | 'appointments'
  | 'announcements'
  | 'events'
  | 'parcel-tracking'
  | 'tickets'
  | 'ticket-create';

/** Map from old page IDs (used in enabledPages) to WidgetView */
const PAGE_ID_MAP: Record<string, WidgetView> = {
  home: 'home',
  messages: 'messages',
  chat: 'chat',
  help: 'faq',
  faq: 'faq',
  status: 'status',
  changelog: 'changelog',
  news: 'news',
  feedback: 'feedback',
  appointments: 'appointments',
  announcements: 'announcements',
  events: 'events',
  'parcel-tracking': 'parcel-tracking',
  tickets: 'tickets',
  'ticket-create': 'ticket-create',
};

export function resolveView(pageId: string): WidgetView {
  return PAGE_ID_MAP[pageId.toLowerCase()] || 'home';
}

interface UseViewRouterReturn {
  currentView: WidgetView;
  navigate: (view: WidgetView) => void;
  goBack: () => boolean;
  canGoBack: boolean;
  /** Navigate to chat, optionally with a conversation ID */
  openChat: (conversationId?: string) => void;
  /** The conversation ID to show in chat view (if navigated via openChat) */
  chatConversationId: string | null;
}

export function useViewRouter(startingPage?: string): UseViewRouterReturn {
  const initialView = resolveView(startingPage || 'home');
  const [currentView, setCurrentView] = useState<WidgetView>(initialView);
  const historyRef = useRef<WidgetView[]>([]);
  const [chatConversationId, setChatConversationId] = useState<string | null>(null);

  const navigate = useCallback((view: WidgetView) => {
    setCurrentView((prev) => {
      historyRef.current.push(prev);
      // Keep history bounded
      if (historyRef.current.length > 20) historyRef.current.shift();
      return view;
    });
  }, []);

  const goBack = useCallback((): boolean => {
    const prev = historyRef.current.pop();
    if (prev) {
      setCurrentView(prev);
      return true;
    }
    return false;
  }, []);

  const openChat = useCallback((conversationId?: string) => {
    if (conversationId) setChatConversationId(conversationId);
    navigate('chat');
  }, [navigate]);

  return {
    currentView,
    navigate,
    goBack,
    canGoBack: historyRef.current.length > 0,
    openChat,
    chatConversationId,
  };
}
