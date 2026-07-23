import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const crmPipelines = pgTable('crm_pipelines', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Pipeline info
  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 1000 }),
  icon: varchar('icon', { length: 100 }), // Lucide icon name
  color: varchar('color', { length: 50 }), // CSS class like 'bg-violet-500'
  template: varchar('template', { length: 100 }), // Template ID from which it was created

  // Settings stored as JSON
  settings: jsonb('settings').$type<Record<string, unknown>>(), // { showProbability, defaultCurrency, etc. }

  // Flags
  isDefault: boolean('is_default').default(false),
  isArchived: boolean('is_archived').default(false),
}, (table) => [
  index('crm_pipelines_template_idx').on(table.template),
  index('crm_pipelines_is_default_idx').on(table.isDefault),
]);

export type CrmPipeline = typeof crmPipelines.$inferSelect;
export type NewCrmPipeline = typeof crmPipelines.$inferInsert;
