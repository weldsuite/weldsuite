/**
 * One realtime connection for the whole app.
 *
 * The shell needs new-mail events for the unread badge and desktop
 * notifications, and the inbox needs them to prepend rows. Both read from this
 * provider so there is a single WebSocket rather than one per component, and
 * so an unread count stays consistent between the sidebar and the list.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '@clerk/clerk-react';
import { WorkspaceClient } from '@weldsuite/realtime/client';
import type { ConnectionState, WorkspaceEvent } from '@weldsuite/realtime/types';
import { personalApi } from '@/lib/api';
import { getRealtimeUrl, mailTopic } from '@/lib/realtime';
import {
  requestNotificationPermission,
  showMailNotification,
} from '@/lib/notifications';

/** Payload published by mail-inbound-worker on `mail:new`. */
export interface NewMailEvent {
  accountId: string;
  /** Stored row id — what `GET /mail/messages/:id` takes. */
  messageId: string;
  smtpMessageId?: string;
  threadId?: string;
  from: { email: string; name?: string };
  subject: string;
  preview: string;
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
}

type NewMailHandler = (event: NewMailEvent) => void;

interface MailEventsValue {
  connectionState: ConnectionState;
  /** Unread messages in the inbox, across every address on the account. */
  unreadCount: number;
  /** Re-read the unread count from the API (after marking something read). */
  refreshUnreadCount: () => Promise<void>;
  /** Adjust the badge immediately, before the API round-trip lands. */
  adjustUnreadCount: (delta: number) => void;
  /** Subscribe to new mail. Returns an unsubscribe function. */
  onNewMail: (handler: NewMailHandler) => () => void;
}

const MailEventsContext = createContext<MailEventsValue | null>(null);

export function MailEventsProvider({ children }: { children: ReactNode }) {
  const { getToken, isSignedIn, userId } = useAuth();
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [unreadCount, setUnreadCount] = useState(0);
  const handlersRef = useRef(new Set<NewMailHandler>());

  const refreshUnreadCount = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const { data } = await personalApi.mailMessages.unreadCount();
      setUnreadCount(data.total);
    } catch {
      // A failed count is cosmetic — leave the previous value rather than
      // flashing the badge to zero.
    }
  }, [isSignedIn]);

  const adjustUnreadCount = useCallback((delta: number) => {
    setUnreadCount((prev) => Math.max(0, prev + delta));
  }, []);

  const onNewMail = useCallback((handler: NewMailHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  // Seed the badge on load; realtime keeps it current from there.
  useEffect(() => {
    void refreshUnreadCount();
  }, [refreshUnreadCount]);

  // Ask once, on first signed-in load, so the first arriving mail can surface.
  useEffect(() => {
    if (!isSignedIn) return;
    void requestNotificationPermission();
  }, [isSignedIn]);

  useEffect(() => {
    if (!isSignedIn || !userId) {
      setConnectionState('disconnected');
      return;
    }

    const client = new WorkspaceClient({
      url: getRealtimeUrl(),
      getToken: async () => (await getToken()) ?? '',
    });

    let disposed = false;

    const offConnection = client.onConnectionChange((state) => {
      if (!disposed) setConnectionState(state);
    });

    const offEvent = client.on(mailTopic(userId), (event: WorkspaceEvent) => {
      if (event.event !== 'mail:new') return;
      const mail = event.data as unknown as NewMailEvent;

      setUnreadCount((prev) => prev + 1);

      showMailNotification({
        title: mail.from?.name || mail.from?.email || 'New email',
        body: mail.subject || mail.preview || 'New email received',
        // The stored row id is stable, so a re-delivered event replaces the
        // existing banner instead of stacking a duplicate.
        tag: mail.messageId,
        onClick: () => {
          window.location.assign(`/inbox/${mail.messageId}`);
        },
      });

      for (const handler of handlersRef.current) {
        try {
          handler(mail);
        } catch (err) {
          console.error('[weldmail] new-mail handler failed:', err);
        }
      }
    });

    // `client.on` above already registered the topic; connect() flushes the
    // subscribe once the socket is open, and re-sends it after a reconnect.
    void client.connect().catch((err) => {
      console.error('[weldmail] realtime connect failed:', err);
    });

    return () => {
      disposed = true;
      offEvent();
      offConnection();
      client.disconnect();
    };
  }, [getToken, isSignedIn, userId]);

  const value = useMemo<MailEventsValue>(
    () => ({
      connectionState,
      unreadCount,
      refreshUnreadCount,
      adjustUnreadCount,
      onNewMail,
    }),
    [connectionState, unreadCount, refreshUnreadCount, adjustUnreadCount, onNewMail],
  );

  return <MailEventsContext.Provider value={value}>{children}</MailEventsContext.Provider>;
}

export function useMailEvents(): MailEventsValue {
  const ctx = useContext(MailEventsContext);
  if (!ctx) {
    throw new Error('useMailEvents must be used inside <MailEventsProvider>');
  }
  return ctx;
}
