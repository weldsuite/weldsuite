/**
 * Notification System Types
 */

export type NotificationType =
  | 'order_created'
  | 'order_updated'
  | 'order_shipped'
  | 'invoice_ready'
  | 'payment_received'
  | 'product_added'
  | 'sync_complete'
  | 'system_announcement'
  | 'system_alert'
  | 'feature_announcement'
  | 'custom_event'
  | 'test'
  // Helpdesk notification types
  | 'conversation.created'
  | 'conversation.message.received'
  | 'conversation.assigned'
  | 'conversation.closed'
  | 'conversation.escalated'
  | 'ticket.created'
  | 'ticket.assigned'
  | 'ticket.resolved'
  | 'ticket.escalated';

export interface NotificationData {
  [key: string]: any;
}

export interface Notification {
  message: string;
  type: NotificationType;
  data?: NotificationData;
  timestamp?: string;
}

export interface NotificationHandler {
  (notification: Notification): void;
}

export interface TypedNotificationHandler {
  type: NotificationType;
  handler: NotificationHandler;
}

// Helpdesk-specific notification data interfaces
export interface HelpdeskConversationData {
  conversationId: string;
  ticketNumber?: string;
  subject?: string;
  customerName?: string;
  channel?: string;
}

export interface HelpdeskMessageData extends HelpdeskConversationData {
  messageId: string;
  senderName: string;
  content: string;
  sentAt: string;
}

export interface HelpdeskTicketData {
  ticketId: string;
  ticketNumber: string;
  subject: string;
  priority?: string;
  status?: string;
  conversationId?: string;
}

export interface HelpdeskAssignmentData extends HelpdeskConversationData {
  assignedToId: string;
  assignedToName?: string;
  assignedAt: string;
}

export interface HelpdeskEscalationData extends HelpdeskTicketData {
  escalatedToId: string;
  escalatedToName?: string;
  escalationLevel: number;
  reason?: string;
  escalatedAt: string;
}

export type HelpdeskNotificationType =
  | 'conversation.created'
  | 'conversation.message.received'
  | 'conversation.assigned'
  | 'conversation.closed'
  | 'conversation.escalated'
  | 'ticket.created'
  | 'ticket.assigned'
  | 'ticket.resolved'
  | 'ticket.escalated';

export function isHelpdeskNotification(type: NotificationType): type is HelpdeskNotificationType {
  return type.startsWith('conversation.') || type.startsWith('ticket.');
}
