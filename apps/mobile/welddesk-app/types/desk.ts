/** Desk conversation model — mirrors platform `use-desk-queries` / `/api/desk/*`. */

export type DeskConversationState = 'open' | 'closed';
export type DeskChannel = 'messenger' | 'email' | 'phone' | 'whatsapp' | 'sms' | 'api';
export type DeskConversationSort = 'newest' | 'oldest' | 'waiting_longest';
export type DeskMessageKind = 'message' | 'note' | 'event';
export type DeskAuthorType = 'visitor' | 'agent' | 'bot' | 'system';
export type DeskEventType = 'closed' | 'reopened' | 'assigned' | 'unassigned';

export interface DeskConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  conversationNumber: number;
  title: string | null;
  state: DeskConversationState;
  channel: DeskChannel;
  visitorId: string | null;
  name: string | null;
  email: string | null;
  contactId: string | null;
  assigneeId: string | null;
  waitingSince: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface DeskMessageAttachment {
  name: string;
  url: string;
  contentType: string;
  filesize: number;
  width?: number;
  height?: number;
}

export interface DeskMessage {
  id: string;
  createdAt: string;
  conversationId: string;
  kind: DeskMessageKind;
  body: string | null;
  authorType: DeskAuthorType;
  authorId: string | null;
  attachments: DeskMessageAttachment[] | null;
  metadata: { eventType?: DeskEventType; assigneeId?: string | null } | null;
}

export interface DeskListPagination {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export interface DeskConversationFilters {
  state?: DeskConversationState;
  assigneeId?: string;
  unassigned?: boolean;
  channel?: DeskChannel;
}

export type DeskConversationWithMessages = DeskConversation & {
  messages: DeskMessage[];
};
