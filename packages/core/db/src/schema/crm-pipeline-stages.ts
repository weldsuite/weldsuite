import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  index,
} from 'drizzle-orm/pg-core';

export const crmPipelineStages = pgTable('crm_pipeline_stages', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Stage info
  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 1000 }),
  position: integer('position').notNull().default(0),
  probability: integer('probability').default(0), // 0-100
  color: varchar('color', { length: 50 }),

  // Pipeline grouping
  pipeline: varchar('pipeline', { length: 100 }).default('default'),

  // Flags
  isDefault: boolean('is_default').default(false),
  isWon: boolean('is_won').default(false),
  isLost: boolean('is_lost').default(false),
}, (table) => [
  index('crm_pipeline_stages_position_idx').on(table.position),
  index('crm_pipeline_stages_pipeline_idx').on(table.pipeline),
]);

export type CrmPipelineStage = typeof crmPipelineStages.$inferSelect;
export type NewCrmPipelineStage = typeof crmPipelineStages.$inferInsert;
