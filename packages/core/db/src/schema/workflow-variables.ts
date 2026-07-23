import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
// Variable Scope Types
export type VariableScope = 'global' | 'workflow' | 'execution';

// Variable Data Types
export type VariableType = 'string' | 'number' | 'boolean' | 'json' | 'secret';

export const workflowVariables = pgTable('workflow_variables', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Workflow Reference (null for global variables)
  workflowId: varchar('workflow_id', { length: 30 }),

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
  index('workflow_variables_workflow_idx').on(table.workflowId),
  index('workflow_variables_scope_idx').on(table.scope),
  index('workflow_variables_name_idx').on(table.name),
  index('workflow_variables_is_secret_idx').on(table.isSecret),
]);

export type WorkflowVariable = typeof workflowVariables.$inferSelect;
export type NewWorkflowVariable = typeof workflowVariables.$inferInsert;
