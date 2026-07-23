import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Trigger events for notifications
export type NotificationTriggerEvent =
  | 'parcel_created'
  | 'parcel_shipped'
  | 'parcel_in_transit'
  | 'parcel_out_for_delivery'
  | 'parcel_delivered'
  | 'parcel_exception'
  | 'return_requested'
  | 'return_approved'
  | 'return_label_created'
  | 'return_received'
  | 'return_processed'
  | 'pickup_scheduled'
  | 'pickup_confirmed';

export type WhatsAppApprovalStatus = 'pending' | 'approved' | 'rejected';
export type WhatsAppMediaType = 'image' | 'document' | 'video';

export interface WhatsAppButton {
  type: 'quick_reply' | 'url' | 'phone';
  text: string;
  url?: string;
  phoneNumber?: string;
}

// Email Templates
export const emailTemplates = pgTable('email_templates', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  name: varchar('name', { length: 255 }).notNull(),

  // Content
  subject: varchar('subject', { length: 500 }).notNull(),
  body: text('body'),
  htmlBody: text('html_body'),

  // Variables
  variables: jsonb('variables').$type<string[]>(),

  // Trigger
  triggerEvent: varchar('trigger_event', { length: 50 }),

  // Status
  isActive: boolean('is_active').default(true),
  isDefault: boolean('is_default').default(false),

  // Usage
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at'),

  // Metadata
  description: text('description'),
  tags: jsonb('tags').$type<string[]>(),
}, (table) => [
  index('email_templates_trigger_event_idx').on(table.triggerEvent),
  index('email_templates_is_active_idx').on(table.isActive),
]);

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;

// SMS Templates
export const smsTemplates = pgTable('sms_templates', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  name: varchar('name', { length: 255 }).notNull(),

  // Content
  message: text('message').notNull(),
  maxLength: integer('max_length').default(160),

  // Variables
  variables: jsonb('variables').$type<string[]>(),

  // Trigger
  triggerEvent: varchar('trigger_event', { length: 50 }),

  // Status
  isActive: boolean('is_active').default(true),
  isDefault: boolean('is_default').default(false),

  // Usage
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at'),

  // Metadata
  description: text('description'),
  tags: jsonb('tags').$type<string[]>(),
}, (table) => [
  index('sms_templates_trigger_event_idx').on(table.triggerEvent),
  index('sms_templates_is_active_idx').on(table.isActive),
]);

export type SmsTemplate = typeof smsTemplates.$inferSelect;
export type NewSmsTemplate = typeof smsTemplates.$inferInsert;

// WhatsApp Templates
export const whatsAppTemplates = pgTable('whatsapp_templates', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  name: varchar('name', { length: 255 }).notNull(),

  // Content
  message: text('message').notNull(),
  headerText: varchar('header_text', { length: 255 }),
  footerText: varchar('footer_text', { length: 255 }),

  // Variables
  variables: jsonb('variables').$type<string[]>(),

  // Media
  mediaType: varchar('media_type', { length: 20 }),
  mediaUrl: varchar('media_url', { length: 500 }),

  // Buttons
  buttons: jsonb('buttons').$type<WhatsAppButton[]>(),

  // Trigger
  triggerEvent: varchar('trigger_event', { length: 50 }),

  // Status
  isActive: boolean('is_active').default(true),
  isDefault: boolean('is_default').default(false),

  // WhatsApp Approval
  approvalStatus: varchar('approval_status', { length: 20 }).default('pending'),

  // Usage
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at'),

  // Metadata
  description: text('description'),
  tags: jsonb('tags').$type<string[]>(),
}, (table) => [
  index('whatsapp_templates_trigger_event_idx').on(table.triggerEvent),
  index('whatsapp_templates_is_active_idx').on(table.isActive),
]);

export type WhatsAppTemplate = typeof whatsAppTemplates.$inferSelect;
export type NewWhatsAppTemplate = typeof whatsAppTemplates.$inferInsert;
