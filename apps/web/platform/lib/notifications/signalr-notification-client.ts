/**
 * SignalR Notification Types
 *
 * `UnifiedNotification` is the shared shape for notifications flowing through
 * the store (`./notification-store`) and the unified notification context.
 * The SignalR-hub client that used to live in this file was dead code (no
 * call sites — real-time delivery now goes through `@weldsuite/realtime`)
 * and was removed; this type is still imported for its shape.
 */

export interface UnifiedNotification {
  id: string;
  notificationType: string;
  category: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
  data?: Record<string, unknown>;
  createdAt: string;
  isRead?: boolean;
  readAt?: string;
}
