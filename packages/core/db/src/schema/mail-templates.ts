import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Template type enum
export const mailTemplateTypeEnum = pgEnum('mail_template_type', [
  'marketing',
  'transactional',
  'notification',
  'newsletter',
  'welcome',
  'custom',
]);

// Template variable interface (stored as JSONB)
export interface MailTemplateVariable {
  name: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'list';
  required?: boolean;
  defaultValue?: unknown;
  description?: string;
}

// Mail Templates table
export const mailTemplates = pgTable('mail_templates', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Template Information
  name: varchar('name', { length: 255 }).notNull(),
  subject: varchar('subject', { length: 998 }).notNull(),
  htmlContent: text('html_content').notNull(),
  textContent: text('text_content'),

  // Organization
  category: varchar('category', { length: 100 }),
  description: text('description'),

  // Variables
  variables: jsonb('variables').$type<MailTemplateVariable[]>(),
  requiredVariables: jsonb('required_variables').$type<string[]>(),

  // Type and purpose
  type: mailTemplateTypeEnum('type').notNull().default('custom'),
  purpose: varchar('purpose', { length: 255 }),

  // Usage statistics
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at'),

  // Status
  isActive: boolean('is_active').notNull().default(true),
  isDefault: boolean('is_default').default(false),

  // Metadata
  tags: jsonb('tags').$type<string[]>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_templates_type_idx').on(table.type),
  index('mail_templates_category_idx').on(table.category),
  index('mail_templates_is_active_idx').on(table.isActive),
  index('mail_templates_is_default_idx').on(table.isDefault),
]);

export type MailTemplate = typeof mailTemplates.$inferSelect;
export type NewMailTemplate = typeof mailTemplates.$inferInsert;
