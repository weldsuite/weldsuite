/**
 * WeldDesk domain types.
 *
 * These are the normalized types used by the useWeldDesk() composition hook
 * and its sub-hooks. They are independent of the transport layer
 * (@weldsuite/realtime WebSocket).
 */

import type { ConnectionState } from '@weldsuite/realtime/types';
import type { MessageBlock, BlockResponse } from '@weldsuite/core-api-client/schemas/welddesk-blocks';

;
;

/** Normalized message type used by useWeldDesk() in both widget and platform */
export interface WeldDeskMessage {
  id: string;
  conversationId: string;
  content: string;
  htmlContent?: string;
  authorType: 'customer' | 'agent' | 'system';
  authorId?: string;
  authorName?: string;
  authorEmail?: string;
  authorAvatar?: string;
  type: 'message' | 'note' | 'system';
  isInternal: boolean;
  isPublic: boolean;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  isRead: boolean;
  attachments?: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
  }>;
  blocks?: MessageBlock[];
  blockResponses?: Record<string, BlockResponse> | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  /** True for optimistic messages not yet confirmed by server */
  isPending?: boolean;
  /** @deprecated kept for backwards compat — use `type` instead */
  messageType?: string;
}

export interface SendMessageParams {
  content: string;
  htmlContent?: string;
  attachments?: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
  }>;
  blocks?: MessageBlock[];
}

/** Conversation event from the helpdeskConversationEvents table */
export interface WeldDeskEvent {
  id: string;
  conversationId: string;
  eventType: string;
  initiator: 'agent' | 'customer' | 'system' | 'automation' | 'ai';
  actorId?: string;
  actorName?: string;
  actorAvatar?: string;
  description: string;
  data?: Record<string, unknown>;
  changes?: Record<string, { from: unknown; to: unknown }>;
  isPublic: boolean;
  createdAt: string;
  relatedMessageId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

export interface WeldDeskTypingUser {
  userId: string;
  userName: string;
  userType: 'agent' | 'customer';
}

export interface WeldDeskTypingState {
  isTyping: boolean;
  typingUsers: WeldDeskTypingUser[];
}

export interface WeldDeskPresenceMember {
  userId: string;
  userName: string;
  userType: 'agent' | 'customer';
  isOnline: boolean;
  data?: Record<string, unknown>;
}

/**
 * Extends the realtime ConnectionState with WeldDesk-specific states.
 * 'failed' is set when the initial connect attempt fails permanently.
 */
export type WeldDeskConnectionState = ConnectionState | 'failed';
