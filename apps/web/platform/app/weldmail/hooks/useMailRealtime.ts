
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
      const eventType = event.event;
      const data = event.data as Record<string, unknown>;

      switch (eventType) {
        case 'mail:new': {
          const email = data as unknown as NewEmailEvent;
          if (accountId && email.accountId !== accountId) return;

          setNewEmailCount((prev) => prev + 1);

          if (showToasts) {
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

          callbacksRef.current.onNewEmail?.(email);
          break;
        }

        case 'mail:sync': {
          const status = data as unknown as EmailSyncEvent;
          if (accountId && status.accountId !== accountId) return;
          callbacksRef.current.onSyncStatus?.(status);
          break;
        }

        case 'mail:read': {
          const readEvent = data as unknown as EmailReadEvent;
          if (accountId && readEvent.accountId !== accountId) return;
          callbacksRef.current.onReadStatusChange?.(readEvent);
          break;
        }

        case 'mail:unread_count': {
          const countEvent = data as unknown as UnreadCountEvent;
          if (accountId && countEvent.accountId !== accountId) return;
          callbacksRef.current.onUnreadCountUpdate?.(countEvent);
          break;
        }

        case 'mail:deleted': {
          const emailId = data.emailId as string;
          const eventAccountId = data.accountId as string;
          if (accountId && eventAccountId !== accountId) return;
          callbacksRef.current.onEmailDeleted?.(emailId, eventAccountId);
          break;
        }

        case 'mail:archived': {
          const emailId = data.emailId as string;
          const eventAccountId = data.accountId as string;
          if (accountId && eventAccountId !== accountId) return;
          callbacksRef.current.onEmailArchived?.(emailId, eventAccountId);
          break;
        }

        case 'mail:starred': {
          const emailId = data.emailId as string;
          const eventAccountId = data.accountId as string;
          const isStarred = data.isStarred as boolean;
          if (accountId && eventAccountId !== accountId) return;
          callbacksRef.current.onEmailStarred?.(emailId, eventAccountId, isStarred);
          break;
        }
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
