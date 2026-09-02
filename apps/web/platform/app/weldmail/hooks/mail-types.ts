/**
 * Mail Event Types (Client-safe)
 *
 * Type definitions for mail real-time events, used by useMailRealtime hook.
 * Transport-independent — works with @weldsuite/realtime WorkspaceHub.
 */

/** New email event data */
export interface NewEmailEvent {
  accountId: string;
  /** Stored row id (`msg_…`) — the id `GET /mail-messages/:id` takes. */
  messageId: string;
  /** RFC 5322 Message-ID header of the delivered mail. */
  smtpMessageId?: string;
  threadId?: string;
  from: {
    email: string;
    name?: string;
  };
  subject: string;
  preview: string;
  receivedAt: string;
  isRead: boolean;
  hasAttachments?: boolean;
  folder?: string;
  priority?: 'high' | 'normal' | 'low';
}

/** Email sync status event */
export interface EmailSyncEvent {
  accountId: string;
  syncStatus: 'started' | 'completed' | 'failed';
  newCount?: number;
  unreadCount?: number;
  error?: string;
}

/** Email read status change event */
export interface EmailReadEvent {
  emailId: string;
  accountId: string;
  isRead: boolean;
}

/** Unread count update event */
export interface UnreadCountEvent {
  accountId: string;
  unreadCount: number;
}
