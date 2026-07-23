// ============================================
// Connection
// ============================================

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting';

// ============================================
// Workspace Hub Events
// ============================================

/** Event received from the WorkspaceHub (entity CRUD, notifications, mail, etc.) */
export interface WorkspaceEvent<T = unknown> {
  topic: string;
  event: string;
  data: T;
  ts: number;
  userId: string;
  /**
   * Monotonic id stamped by the WorkspaceHub when the event was persisted to
   * its replay log. Clients persist this as a cursor and pass it back on
   * reconnect as `subscribe.since`.
   */
  eventId?: string;
}

// ============================================
// Room Events (Conversation + Chat)
// ============================================

export interface Attachment {
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
}

export interface PresenceMember<T = Record<string, unknown>> {
  userId: string;
  userName: string;
  data?: T;
}

export interface TypingUser {
  userId: string;
  userName: string;
}

/** Message received in a ConversationRoom or ChatRoom */
export interface RoomMessage {
  id: string;
  content: string;
  senderId: string;
  senderName: string;
  senderType: string;
  ts: number;
  threadId?: string;
  attachments?: Attachment[];
}

/** Discriminated union of all room event types */
export type RoomEvent =
  | { type: 'message'; id: string; content: string; htmlContent?: string; senderId: string; senderName: string; senderAvatar?: string; senderType: string; authorType?: string; ts: number; seq?: number; threadId?: string; attachments?: Attachment[]; forwardedFrom?: unknown }
  | { type: 'message:updated'; id: string; data: Record<string, unknown> }
  | { type: 'message:deleted'; id: string }
  | { type: 'system'; event: string; data: unknown; ts: number }
  | { type: 'typing'; userId: string; userName: string; isTyping: boolean }
  | { type: 'presence:join'; member: PresenceMember }
  | { type: 'presence:leave'; userId: string }
  | { type: 'ai:token'; messageId: string; token: string }
  | { type: 'ai:complete'; messageId: string; content: string }
  | { type: 'reaction'; messageId: string; emoji: string; userId: string; action: 'add' | 'remove' }
  | { type: 'pin'; messageId: string; action: 'pinned' | 'unpinned'; userId: string }
  | { type: 'member'; userId: string; userName: string; action: 'joined' | 'left' }
  | { type: 'channel:updated'; data: unknown }
  | { type: 'call'; action: 'started' | 'ended'; callId: string; initiatorId: string }
  | { type: 'call:participant'; callId: string; userId: string; userName: string; userAvatar?: string; cfSessionId?: string; action: 'joined' | 'left' }
  | { type: 'call:track'; callId: string; userId: string; trackName: string; trackType: string; action: 'added' | 'removed' }
  | { type: 'call:incoming'; callId: string; channelId: string; callType: string; callerName: string; callerAvatar?: string }
  | { type: 'call:hand-raised'; userId: string }
  | { type: 'call:hand-lowered'; userId: string }
  | { type: 'read:updated'; channelId: string; userId: string; userName: string; userAvatar?: string; lastReadMessageId: string; lastReadAt: string }
  | { type: 'clip:transcript:updated'; messageId: string; attachmentId: string; transcript: unknown }
  | { type: 'unread:update'; channelId: string; unreadCount: number };

// ============================================
// Protocol Messages
// ============================================

/** Messages the client sends to the WorkspaceHub */
export type WorkspaceClientMessage =
  | { type: 'subscribe'; topics: string[]; since?: string }
  | { type: 'unsubscribe'; topics: string[] }
  | { type: 'ping' };

/** Messages the WorkspaceHub sends to the client */
export type WorkspaceServerMessage =
  | { type: 'connected'; connectionId: string }
  | { type: 'subscribed'; topics: string[] }
  | { type: 'unsubscribed'; topics: string[] }
  | { type: 'event'; topic: string; event: string; data: unknown; ts: number; userId: string; eventId?: string }
  | { type: 'resync_required'; topics: string[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

/** Messages the client sends to a ConversationRoom */
export type ConversationClientMessage =
  | { type: 'message'; content: string; attachments?: Attachment[] }
  | { type: 'typing:start' }
  | { type: 'typing:stop' }
  | { type: 'presence:enter'; data?: Record<string, unknown> }
  | { type: 'presence:leave' }
  | { type: 'ping' };

/** Messages the ConversationRoom sends to the client */
export type ConversationServerMessage =
  | { type: 'connected'; connectionId: string; presence: PresenceMember[] }
  | { type: 'message'; id: string; content: string; senderId: string; senderName: string; senderType: string; ts: number; attachments?: Attachment[] }
  | { type: 'system'; event: string; data: unknown; ts: number }
  | { type: 'typing'; userId: string; userName: string; isTyping: boolean }
  | { type: 'presence:join'; member: PresenceMember }
  | { type: 'presence:leave'; userId: string }
  | { type: 'ai:token'; messageId: string; token: string }
  | { type: 'ai:complete'; messageId: string; content: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

/** Messages the client sends to a ChatRoom */
export type ChatClientMessage =
  | { type: 'message'; content: string; threadId?: string; attachments?: Attachment[] }
  | { type: 'reaction:add'; messageId: string; emoji: string }
  | { type: 'reaction:remove'; messageId: string; emoji: string }
  | { type: 'typing:start' }
  | { type: 'typing:stop' }
  | { type: 'presence:enter'; data?: Record<string, unknown> }
  | { type: 'presence:leave' }
  | { type: 'call:hand-raised' }
  | { type: 'call:hand-lowered' }
  | { type: 'ping' };

/** Messages the ChatRoom sends to the client */
export type ChatServerMessage =
  | { type: 'connected'; connectionId: string; presence: PresenceMember[]; lastSeq: number }
  | { type: 'message'; id: string; content: string; senderId: string; senderName: string; senderAvatar?: string; authorType?: string; ts: number; seq: number; threadId?: string; attachments?: Attachment[] }
  | { type: 'message:updated'; id: string; data: Record<string, unknown> }
  | { type: 'message:deleted'; id: string }
  | { type: 'reaction'; messageId: string; emoji: string; userId: string; action: 'add' | 'remove' }
  | { type: 'pin'; messageId: string; action: 'pinned' | 'unpinned'; userId: string }
  | { type: 'member'; userId: string; userName: string; action: 'joined' | 'left' }
  | { type: 'channel:updated'; data: unknown }
  | { type: 'call'; action: 'started' | 'ended'; callId: string; initiatorId: string }
  | { type: 'call:participant'; callId: string; userId: string; userName: string; userAvatar?: string; cfSessionId?: string; action: 'joined' | 'left' }
  | { type: 'call:track'; callId: string; userId: string; trackName: string; trackType: string; action: 'added' | 'removed' }
  | { type: 'call:incoming'; callId: string; channelId: string; callType: string; callerName: string; callerAvatar?: string }
  | { type: 'call:hand-raised'; userId: string }
  | { type: 'call:hand-lowered'; userId: string }
  | { type: 'read:updated'; channelId: string; userId: string; userName: string; userAvatar?: string; lastReadMessageId: string; lastReadAt: string }
  | { type: 'clip:transcript:updated'; messageId: string; attachmentId: string; transcript: unknown }
  | { type: 'unread:update'; channelId: string; unreadCount: number }
  | { type: 'typing'; userId: string; userName: string; isTyping: boolean }
  | { type: 'presence:join'; member: PresenceMember }
  | { type: 'presence:leave'; userId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
