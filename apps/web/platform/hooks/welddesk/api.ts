/**
 * WeldDesk API adapter for the platform (agent-side).
 *
 * Targets app-api's `/api/conversations/*` surface. The conversation-message
 * half of this file used to call api-worker's `/helpdesk/conversations/*`
 * because app-api had no route that touched `helpdesk_conversation_messages`;
 * W5b ported that surface, so everything here is on app-api and the legacy
 * api-worker browser client dependency is gone.
 *
 * Envelope note: app-api returns `{ data }` / `{ data, pagination }`, not the
 * legacy `{ success, data }`. Non-2xx throws, so there is no `success` flag to
 * branch on — these helpers unwrap `data` directly.
 */

import type { ClientApi } from '@weldsuite/api-client/types';
import type {
  WeldDeskMessage,
  WeldDeskEvent,
  SendMessageParams,
} from './types';

export interface WeldDeskConversation {
  id: string;
  conversationNumber: string;
  subject: string;
  preview?: string | null;
  status: string;
  priority?: string | null;
  channel: string;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerCompany?: string | null;
  customerAvatar?: string | null;
  contactId?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  assigneeAvatar?: string | null;
  departmentId?: string | null;
  messageCount: number;
  unreadCount?: number | null;
  lastMessageAt?: string | null;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isTicket: boolean;
  ticketNumber?: string | null;
  tags?: string[] | null;
  labels?: string[] | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ConversationUpdate {
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  assigneeName?: string | null;
  departmentId?: string | null;
  tags?: string[];
  labels?: string[];
  isStarred?: boolean;
  isArchived?: boolean;
  isRead?: boolean;
}

// --------------------------------------------------------------------------
// API functions — take a pre-authenticated app-api client
// --------------------------------------------------------------------------

export async function fetchConversation(
  client: ClientApi,
  conversationId: string,
): Promise<WeldDeskConversation> {
  const res = await client.get<{ data: WeldDeskConversation }>(
    `/conversations/${conversationId}`,
  );
  return res.data;
}

export async function fetchMessages(
  client: ClientApi,
  conversationId: string,
): Promise<{ data: WeldDeskMessage[]; hasMore: boolean }> {
  const res = await client.get<{ data: WeldDeskMessage[] }>(
    `/conversations/${conversationId}/messages`,
  );
  return { data: res.data ?? [], hasMore: false };
}

export async function fetchEvents(
  client: ClientApi,
  conversationId: string,
): Promise<WeldDeskEvent[]> {
  try {
    const res = await client.get<{ data: WeldDeskEvent[] }>(
      `/conversations/${conversationId}/events`,
    );
    return res.data ?? [];
  } catch {
    // Timeline events are supplementary — a failure here must not blank the
    // message thread, so degrade to "no events" rather than throwing.
    return [];
  }
}

export async function sendMessage(
  client: ClientApi,
  conversationId: string,
  params: SendMessageParams & { isInternal?: boolean; authorName?: string },
): Promise<WeldDeskMessage> {
  const res = await client.post<{ data: WeldDeskMessage }>(
    `/conversations/${conversationId}/messages`,
    {
      content: params.content,
      contentHtml: params.htmlContent,
      isInternal: params.isInternal ?? false,
      authorName: params.authorName,
      attachments: params.attachments,
      blocks: params.blocks,
    },
  );
  return res.data;
}

export async function respondToBlock(
  client: ClientApi,
  conversationId: string,
  messageId: string,
  actionId: string,
  value: unknown,
): Promise<void> {
  await client.patch(
    `/conversations/${conversationId}/messages/${messageId}/respond`,
    { actionId, value },
  );
}

export async function updateConversation(
  client: ClientApi,
  conversationId: string,
  fields: Partial<ConversationUpdate>,
): Promise<void> {
  await client.patch(`/conversations/${conversationId}`, fields);
}

/**
 * Closing goes through `/status` rather than the generic PATCH so the server
 * derives the close side effects (clears `snoozedUntil`, stamps `closedAt`,
 * publishes `conversation_closed`, archives the Discord ticket thread).
 */
export async function closeConversation(
  client: ClientApi,
  conversationId: string,
  reason?: string,
): Promise<void> {
  await client.patch(`/conversations/${conversationId}/status`, {
    status: 'closed',
    reason,
  });
}

export async function reopenConversation(
  client: ClientApi,
  conversationId: string,
): Promise<void> {
  await client.patch(`/conversations/${conversationId}/status`, {
    status: 'active',
  });
}
