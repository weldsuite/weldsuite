import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Notification category types (maps to platform modules)
export type NotificationCategory =
  | 'helpdesk'
  | 'crm'
  | 'wms'
  | 'mail'
  | 'projects'
  | 'parcel'
  | 'task'
  | 'weldchat'
  | 'system'
  | 'security';

// Notification severity levels
export type NotificationSeverity = 'info' | 'warning' | 'error' | 'success';

// Notification type (action that triggered it)
export type NotificationType =
  | 'ticket_created'
  | 'ticket_assigned'
  | 'ticket_updated'
  | 'ticket_resolved'
  | 'message_received'
  | 'lead_created'
  | 'opportunity_updated'
  | 'order_created'
  | 'order_shipped'
  | 'inventory_low'
  | 'task_assigned'
  | 'task_completed'
  | 'project_updated'
  | 'mention'
  | 'chat_mention'
  | 'chat_dm'
  | 'chat_missed_call'
  | 'chat_incoming_call'
  | 'chat_thread_reply'
  | 'comment'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'security_alert'
  | 'system_update'
  | 'access_request'
  | 'access_request_resolved'
  | 'custom';

export const notifications = pgTable('notifications', {
  // Base fields
  id: varchar('id', { length: 30 }).primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(), // Target user

  // Content
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body'),

  // Categorization
  category: varchar('category', { length: 50 }).notNull().default('system'),
  notificationType: varchar('notification_type', { length: 50 }).notNull().default('custom'),

  // Related entity (for navigation)
  entityType: varchar('entity_type', { length: 50 }), // ticket, order, task, etc.
  entityId: varchar('entity_id', { length: 30 }),
  actionUrl: varchar('action_url', { length: 500 }), // Direct link to the entity

  // Actor (who triggered this notification) — polymorphic
  actorType: varchar('actor_type', { length: 20 }), // 'user' | 'contact' | 'system' | null
  actorId: varchar('actor_id', { length: 255 }), // userId for 'user', contactId for 'contact', null for 'system'

  // Display
  icon: varchar('icon', { length: 50 }), // Icon name (e.g., 'ticket', 'package')
  severity: varchar('severity', { length: 20 }).notNull().default('info'),

  // Extra payload data
  data: jsonb('data').$type<Record<string, unknown>>(),

  // Read status
  isRead: boolean('is_read').notNull().default(false),
  readAt: timestamp('read_at', { withTimezone: true }),

  // Delivery tracking
  deliveredInApp: boolean('delivered_in_app').notNull().default(true),
  deliveredEmail: boolean('delivered_email').notNull().default(false),
  deliveredPush: boolean('delivered_push').notNull().default(false),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }), // Auto-delete after this time
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  // Primary query: user's notifications
  index('notifications_user_idx').on(table.userId),
  // Unread notifications query
  index('notifications_user_unread_idx').on(table.userId, table.isRead),
  // Recent notifications
  index('notifications_created_at_idx').on(table.createdAt),
  // By category
  index('notifications_category_idx').on(table.category),
  // By entity (for deduplication or updates)
  index('notifications_entity_idx').on(table.entityType, table.entityId),
]);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
