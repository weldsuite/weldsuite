/**
 * Pure inbox hub-event → callback dispatch for welddesk-app.
 * Kept React-free so it can be unit-tested without jest-expo.
 */

export interface InboxConversation {
  id: string;
  subject?: string;
  channel?: string;
  status?: string;
  priority?: string;
  contactName?: string;
  customerName?: string;
  customerId?: string;
  assignedToId?: string;
  assignedToName?: string;
  lastMessagePreview?: string;
  lastMessageTime?: string;
  unreadCount?: number;
  isRead?: boolean;
  isStarred?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface InboxNewMessageEvent {
  conversationId: string;
  preview: string;
  timestamp: string;
  senderId?: string;
  senderName?: string;
  senderType: 'customer' | 'agent' | 'system';
}

export interface InboxRealtimeHandlers {
  onNewConversation?: (conversation: InboxConversation) => void;
  onConversationUpdated?: (conversation: InboxConversation) => void;
  onNewMessage?: (data: InboxNewMessageEvent) => void;
  onConversationClosed?: (conversationId: string) => void;
  onConversationRead?: (conversationId: string) => void;
  /** Fired for any inbox-affecting hub event — prefer refetch over patching. */
  onInboxInvalidate?: () => void;
}

type LoosePayload = Record<string, unknown>;

function asRecord(data: unknown): LoosePayload {
  if (data && typeof data === 'object') return data as LoosePayload;
  return {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function conversationIdFrom(data: LoosePayload): string {
  return str(data.conversationId) || str(data.id) || '';
}

function mapConversation(data: LoosePayload): InboxConversation {
  return {
    id: conversationIdFrom(data),
    subject: str(data.subject) ?? str(data.title) ?? undefined,
    customerName: str(data.customerName) ?? str(data.name) ?? undefined,
    contactName: str(data.contactName) ?? undefined,
    status: str(data.status) ?? str(data.state) ?? 'active',
    channel: str(data.channel),
    priority: str(data.priority),
    assignedToId: str(data.assigneeId) ?? str(data.assignedToId) ?? undefined,
    assignedToName: str(data.assigneeName) ?? str(data.assignedToName) ?? undefined,
    lastMessagePreview:
      str(data.lastMessagePreview) ?? str(data.preview) ?? undefined,
    lastMessageTime: str(data.lastMessageAt) ?? str(data.updatedAt) ?? undefined,
    createdAt: str(data.createdAt),
    updatedAt: str(data.updatedAt) ?? str(data.createdAt),
  };
}

function mapMessage(data: LoosePayload): InboxNewMessageEvent {
  const authorType = str(data.authorType) ?? str(data.senderType);
  let senderType: InboxNewMessageEvent['senderType'] = 'customer';
  if (authorType === 'agent' || authorType === 'bot') senderType = 'agent';
  else if (authorType === 'system') senderType = 'system';
  else if (authorType === 'visitor' || authorType === 'customer') senderType = 'customer';

  return {
    conversationId: conversationIdFrom(data),
    preview: str(data.preview) ?? str(data.content) ?? str(data.body) ?? '',
    timestamp: str(data.timestamp) ?? str(data.createdAt) ?? new Date().toISOString(),
    senderId: str(data.senderId) ?? str(data.authorId) ?? undefined,
    senderName: str(data.senderName) ?? undefined,
    senderType,
  };
}

/** Hub topics the inbox list should subscribe to (legacy + entity). */
export const INBOX_HUB_TOPICS = [
  'helpdesk',
  'desk_conversation',
  'desk_message',
  'helpdesk_conversation',
  'helpdesk_conversation_message',
] as const;

/**
 * Map a WorkspaceHub event onto inbox callbacks.
 * Topic is the hub topic (= catalog entityType, or bare `helpdesk` for legacy).
 */
export function dispatchInboxRealtimeEvent(
  topic: string,
  eventName: string,
  data: unknown,
  handlers: InboxRealtimeHandlers,
): void {
  const payload = asRecord(data);
  const bump = () => handlers.onInboxInvalidate?.();

  if (topic === 'helpdesk') {
    switch (eventName) {
      case 'conversation_new':
        handlers.onNewConversation?.(mapConversation(payload));
        bump();
        return;
      case 'message_new':
        handlers.onNewMessage?.(mapMessage(payload));
        bump();
        return;
      case 'conversation_updated':
        handlers.onConversationUpdated?.(mapConversation(payload));
        bump();
        return;
      case 'conversation_read':
        handlers.onConversationRead?.(conversationIdFrom(payload));
        bump();
        return;
      case 'conversation_closed':
        handlers.onConversationClosed?.(conversationIdFrom(payload));
        bump();
        return;
      default:
        return;
    }
  }

  if (topic === 'desk_conversation' || topic === 'helpdesk_conversation') {
    if (eventName === 'created') {
      handlers.onNewConversation?.(mapConversation(payload));
      bump();
      return;
    }
    if (eventName === 'closed' || eventName === 'resolved') {
      handlers.onConversationClosed?.(conversationIdFrom(payload));
      bump();
      return;
    }
    handlers.onConversationUpdated?.(mapConversation(payload));
    bump();
    return;
  }

  if (topic === 'desk_message' || topic === 'helpdesk_conversation_message') {
    if (eventName === 'created' || eventName === 'updated') {
      handlers.onNewMessage?.(mapMessage(payload));
      bump();
    }
  }
}
