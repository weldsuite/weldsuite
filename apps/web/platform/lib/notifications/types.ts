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

interface NewEmailNotification {
  emailAccountId: string;
  emailId: string;
  sender: string;
  senderName?: string;
  subject: string;
  preview?: string;
  receivedAt: string;
}

export interface NotificationMessage<T = any> {
  type: NotificationType;
  message: string;
  data?: T;
  timestamp: string;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface WebSocketConfig {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
}

export interface NotificationHandler<T = any> {
  (notification: NotificationMessage<T>): void;
}

interface TypedNotificationHandler<T = any> {
  type: NotificationType;
  handler: NotificationHandler<T>;
}
