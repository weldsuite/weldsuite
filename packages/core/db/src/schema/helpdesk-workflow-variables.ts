import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { helpdeskWorkflows } from './helpdesk-workflows';

export const helpdeskWorkflowVariables = pgTable('helpdesk_workflow_variables', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Workflow Reference (null for global variables, FK to helpdesk_workflows)
  helpdeskWorkflowId: varchar('helpdesk_workflow_id', { length: 30 }).references(() => helpdeskWorkflows.id),

  // Variable Info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  scope: varchar('scope', { length: 20 }).notNull().default('workflow'), // global | workflow | execution

  // Value
  type: varchar('type', { length: 20 }).notNull().default('string'), // string | number | boolean | json | secret
  value: jsonb('value').$type<unknown>(), // Stored as JSON for flexibility
  defaultValue: jsonb('default_value').$type<unknown>(),

  // Security
  isSecret: boolean('is_secret').notNull().default(false),
  isEncrypted: boolean('is_encrypted').notNull().default(false),
  encryptedValue: text('encrypted_value'), // For secrets

  // Metadata
  category: varchar('category', { length: 100 }),
  tags: jsonb('tags').$type<string[]>(),

  // Last modified by
  modifiedBy: varchar('modified_by', { length: 255 }),
}, (table) => [
  index('hd_wf_variables_workflow_idx').on(table.helpdeskWorkflowId),
  index('hd_wf_variables_scope_idx').on(table.scope),
  index('hd_wf_variables_name_idx').on(table.name),
  index('hd_wf_variables_is_secret_idx').on(table.isSecret),
]);

export type HelpdeskWorkflowVariable = typeof helpdeskWorkflowVariables.$inferSelect;
export type NewHelpdeskWorkflowVariable = typeof helpdeskWorkflowVariables.$inferInsert;
