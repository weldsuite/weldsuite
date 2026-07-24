/**
 * WebSocket Notification Types
 * Based on WeldSuite.Backend WebSocket Notifications infrastructure
 */

type NotificationType =
  | 'test'
  | 'order_created'
  | 'order_updated'
  | 'invoice_ready'
  | 'payment_received'
  | 'product_added'
  | 'system_announcement'
  | 'system_alert'
  | 'profile_updated'
  | 'task_assigned'
  | 'task_completed'
  | 'meeting_reminder'
  | 'message_received'
  | 'new_email'
  | 'badge_update'
  | string; // Allow custom types

export interface NotificationMessage<T = unknown> {
  type: NotificationType;
  message: string;
  data?: T;
  timestamp: string;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface NotificationHandler<T = unknown> {
  (notification: NotificationMessage<T>): void;
}
