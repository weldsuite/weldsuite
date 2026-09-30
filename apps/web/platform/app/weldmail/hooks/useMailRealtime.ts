
import { useEffect, useCallback, useState, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import { useRealtimeConnection } from '@weldsuite/realtime/react';
import { topics } from '@weldsuite/realtime/topics';
import type { ConnectionState, WorkspaceEvent } from '@weldsuite/realtime/types';
import type {
  NewEmailEvent,
  EmailSyncEvent,
  EmailReadEvent,
  UnreadCountEvent,
} from './mail-types';

/**
 * Mail real-time event types
 */
export type MailEventType =
  | 'mail:new'
  | 'mail:sync'
  | 'mail:read'
  | 'mail:unread_count'
  | 'mail:deleted'
  | 'mail:archived'
  | 'mail:starred';

/**
 * Mail event data union type
 */
export type MailEventData =
  | (NewEmailEvent & { type: 'mail:new' })
  | (EmailSyncEvent & { type: 'mail:sync' })
  | (EmailReadEvent & { type: 'mail:read' })
  | (UnreadCountEvent & { type: 'mail:unread_count' })
  | { type: 'mail:deleted'; emailId: string; accountId: string }
  | { type: 'mail:archived'; emailId: string; accountId: string }
  | { type: 'mail:starred'; emailId: string; accountId: string; isStarred: boolean };

/**
 * Hook options
 */
export interface UseMailRealtimeOptions {
  /** The mail account ID to filter events for (optional - if not provided, all accounts) */
  accountId?: string;
  /** Callback when a new email arrives */
  onNewEmail?: (email: NewEmailEvent) => void;
  /** Callback when sync status changes */
  onSyncStatus?: (status: EmailSyncEvent) => void;
  /** Callback when email read status changes */
  onReadStatusChange?: (event: EmailReadEvent) => void;
  /** Callback when unread count updates */
  onUnreadCountUpdate?: (event: UnreadCountEvent) => void;
  /** Callback when email is deleted */
  onEmailDeleted?: (emailId: string, accountId: string) => void;
  /** Callback when email is archived */
  onEmailArchived?: (emailId: string, accountId: string) => void;
  /** Callback when email starred status changes */
  onEmailStarred?: (emailId: string, accountId: string, isStarred: boolean) => void;
  /** Whether to show toast notifications for new emails */
  showToasts?: boolean;
  /** Whether the hook is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook return value
 */
export interface UseMailRealtimeReturn {
  /** Whether connected to real-time channel */
  isConnected: boolean;
  /** Connection status */
  connectionStatus: ConnectionState;
  /** Manually trigger a reconnect */
  reconnect: () => void;
  /** Number of new emails received since mount */
  newEmailCount: number;
  /** Reset new email count */
  resetNewEmailCount: () => void;
}

type MailTranslate = ReturnType<typeof useTranslations>;

/** Toast shown when a new email arrives in real time. */
function showNewEmailToast(email: NewEmailEvent, t: MailTranslate): void {
  toast.info(
    t('sweep.weldmail.realtime.newEmailFrom', {
      sender: email.from.name || email.from.email,
    }),
    {
      description: email.subject,
      duration: 5000,
    }
  );
}

/**
 * Hook for real-time mail updates via @weldsuite/realtime WorkspaceHub.
 *
 * Subscribes to the `mail.<userId>` topic on the shared WorkspaceClient
 * (provided by RealtimeProvider). Multiple components can use this hook
 * simultaneously — the WorkspaceClient handles topic deduplication.
 *
 * @example
 * ```tsx
 * const { isConnected, newEmailCount } = useMailRealtime({
 *   accountId: 'account-123',
 *   onNewEmail: (email) => {
 *     console.log('New email:', email.subject);
 *     refreshMessages();
 *   },
 *   showToasts: true,
 * });
 * ```
 */
export function useMailRealtime(options: UseMailRealtimeOptions = {}): UseMailRealtimeReturn {
  const {
    accountId,
    onNewEmail,
    onSyncStatus,
    onReadStatusChange,
    onUnreadCountUpdate,
    onEmailDeleted,
    onEmailArchived,
    onEmailStarred,
    showToasts = true,
    enabled = true,
  } = options;

  const { userId } = useAuth();
  const t = useTranslations();
  const client = useWorkspaceClientMaybe();
  const { state: connectionStatus, isConnected } = useRealtimeConnection();
  const [newEmailCount, setNewEmailCount] = useState(0);

  // Stable callback refs to avoid re-subscribing
  const callbacksRef = useRef({
    onNewEmail,
    onSyncStatus,
    onReadStatusChange,
    onUnreadCountUpdate,
    onEmailDeleted,
    onEmailArchived,
    onEmailStarred,
  });

  // `useTranslations()` returns a new function every render; keep the latest
  // in a ref so the subscribe effect below doesn't need to re-run (and
  // re-subscribe to the realtime topic) on every render.
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    callbacksRef.current = {
      onNewEmail,
      onSyncStatus,
      onReadStatusChange,
      onUnreadCountUpdate,
      onEmailDeleted,
      onEmailArchived,
      onEmailStarred,
    };
  }, [
    onNewEmail,
    onSyncStatus,
    onReadStatusChange,
    onUnreadCountUpdate,
    onEmailDeleted,
    onEmailArchived,
    onEmailStarred,
  ]);

  const reconnect = useCallback(() => {
    // WorkspaceClient handles reconnection automatically
  }, []);

  const resetNewEmailCount = useCallback(() => {
    setNewEmailCount(0);
  }, []);

  // Subscribe to mail topic via WorkspaceClient
  useEffect(() => {
    if (!enabled || !userId || !client) return;

    const topic = topics.mail(userId);

    const unsub = client.on(topic, (event: WorkspaceEvent) => {
      const data = event.data as Record<string, unknown>;
      // Every mail event carries the owning account; drop other accounts' events.
      if (accountId && data.accountId !== accountId) return;

      const callbacks = callbacksRef.current;
      const emailId = data.emailId as string;
      const eventAccountId = data.accountId as string;

      switch (event.event) {
        case 'mail:new': {
          const email = data as unknown as NewEmailEvent;
          setNewEmailCount((prev) => prev + 1);
          if (showToasts) showNewEmailToast(email, tRef.current);
          callbacks.onNewEmail?.(email);
          break;
        }
        case 'mail:sync':
          callbacks.onSyncStatus?.(data as unknown as EmailSyncEvent);
          break;
        case 'mail:read':
          callbacks.onReadStatusChange?.(data as unknown as EmailReadEvent);
          break;
        case 'mail:unread_count':
          callbacks.onUnreadCountUpdate?.(data as unknown as UnreadCountEvent);
          break;
        case 'mail:deleted':
          callbacks.onEmailDeleted?.(emailId, eventAccountId);
          break;
        case 'mail:archived':
          callbacks.onEmailArchived?.(emailId, eventAccountId);
          break;
        case 'mail:starred':
          callbacks.onEmailStarred?.(emailId, eventAccountId, data.isStarred as boolean);
          break;
      }
    });

    return unsub;
  }, [enabled, userId, client, accountId, showToasts]);

  return {
    isConnected,
    connectionStatus,
    reconnect,
    newEmailCount,
    resetNewEmailCount,
  };
}
