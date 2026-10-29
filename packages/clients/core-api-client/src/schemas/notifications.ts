import { z } from 'zod';

// ============================================================================
// Input Schemas
// ============================================================================

// CRUD schemas for /api/notifications (app-api).
export const createNotificationSchema = z.object({
  userId: z.string().nullish(),
  type: z.string().max(50).optional(),
  title: z.string().max(500).optional(),
  body: z.string().optional(),
  link: z.string().optional(),
  isRead: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateNotificationSchema = createNotificationSchema.partial();

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
export type UpdateNotificationInput = z.infer<typeof updateNotificationSchema>;

export const listNotificationsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  category: z.string().optional(),
  isRead: z.enum(['true', 'false']).optional(),
  severity: z.string().optional(),
});

export const batchIdsInput = z.object({
  notificationIds: z.array(z.string()).min(1),
});

// ============================================================================
// Inferred Input Types
// ============================================================================

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;
export type BatchIdsInput = z.infer<typeof batchIdsInput>;

// ============================================================================
// Response Types
// ============================================================================

export type NotificationActorType = 'user' | 'contact' | 'system';

export interface NotificationActor {
  type: NotificationActorType;
  id: string | null;
  name: string;
  imageUrl: string | null;
}

export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string | null;
  category: string;
  notificationType: string;
  entityType: string | null;
  entityId: string | null;
  actionUrl: string | null;
  icon: string | null;
  severity: 'info' | 'warning' | 'error' | 'success';
  data: Record<string, unknown> | null;
  isRead: boolean;
  readAt: string | null;
  deliveredInApp: boolean;
  deliveredEmail: boolean;
  deliveredPush: boolean;
  createdAt: string;
  expiresAt: string | null;
  /** Actor that triggered the notification (hydrated server-side). */
  actor: NotificationActor | null;
}

export interface UnreadCountResponse {
  count: number;
}

export interface SuccessResponse {
  success: true;
}

export interface BatchSuccessResponse {
  success: true;
  count: number;
}

// ============================================================================
// App-API response schemas (/api/notifications, app-api routes/notifications)
// ============================================================================

/** A `notifications` row, as GET /:id and POST /:id/read answer it. */
export const notificationRowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  category: z.string(),
  notificationType: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  actionUrl: z.string().nullable(),
  actorType: z.string().nullable(),
  actorId: z.string().nullable(),
  icon: z.string().nullable(),
  severity: z.string(),
  data: z.record(z.unknown()).nullable(),
  isRead: z.boolean(),
  readAt: z.string().nullable(),
  deliveredInApp: z.boolean(),
  deliveredEmail: z.boolean(),
  deliveredPush: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

/** GET /: a row with its actor's name and picture (user actors with a member row only). */
export const notificationListItemSchema = notificationRowSchema.extend({
  actorName: z.string().nullable(),
  actorAvatar: z.string().nullable(),
});

/** GET /unread-count. */
export const unreadCountSchema = z.object({ count: z.number().int() });

/** POST /read-all: how many rows it marked read. */
export const markedReadCountSchema = z.object({ updated: z.number().int() });

/** POST / and PATCH /:id: the row's id. */
export const notificationRefSchema = z.object({ id: z.string() });

export type NotificationRow = z.infer<typeof notificationRowSchema>;
export type NotificationListItem = z.infer<typeof notificationListItemSchema>;
