import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import type { WorkflowStep, TriggerConfig, WorkflowSettings } from './workflows';

// Template Difficulty Levels
export type TemplateDifficulty = 'beginner' | 'intermediate' | 'advanced';

// Template Categories
export type TemplateCategory =
  | 'marketing' | 'sales' | 'support' | 'hr'
  | 'finance' | 'operations' | 'development'
  | 'productivity' | 'communication' | 'data'
  | 'custom';

export const workflowTemplates = pgTable('workflow_templates', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Template Info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  shortDescription: varchar('short_description', { length: 500 }),
  category: varchar('category', { length: 50 }).notNull(), // marketing | sales | support | etc

  // Workflow Definition (snapshot)
  triggers: jsonb('triggers').$type<TriggerConfig[]>(),
  steps: jsonb('steps').$type<WorkflowStep[]>(),
  settings: jsonb('settings').$type<WorkflowSettings>(),

  // Configuration Schema (for customization)
  configurationSchema: jsonb('configuration_schema').$type<{
    fields: Array<{
      name: string;
      type: 'string' | 'number' | 'boolean' | 'select' | 'multiselect';
      label: string;
      description?: string;
      required?: boolean;
      default?: unknown;
      options?: Array<{ label: string; value: string }>;
    }>;
  }>(),

  // Difficulty and Metadata
  difficulty: varchar('difficulty', { length: 20 }).default('beginner'), // beginner | intermediate | advanced
  estimatedSetupTime: integer('estimated_setup_time'), // minutes
  tags: jsonb('tags').$type<string[]>(),

  // Visuals
  thumbnail: varchar('thumbnail', { length: 500 }),
  icon: varchar('icon', { length: 255 }),
  color: varchar('color', { length: 20 }),

  // Author
  authorId: varchar('author_id', { length: 255 }),
  authorName: varchar('author_name', { length: 255 }),
  authorAvatar: varchar('author_avatar', { length: 500 }),

  // Publishing
  isOfficial: boolean('is_official').notNull().default(false), // Maintained by WeldSuite
  isPublic: boolean('is_public').notNull().default(false), // Visible to all users
  isVerified: boolean('is_verified').notNull().default(false), // Reviewed and approved
  publishedAt: timestamp('published_at'),

  // Usage Statistics
  usageCount: integer('usage_count').default(0),
  rating: numeric('rating', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').default(0),

  // Required Integrations
  requiredIntegrations: jsonb('required_integrations').$type<string[]>(),

  // Version
  version: varchar('version', { length: 20 }).default('1.0.0'),
}, (table) => [
  index('workflow_templates_category_idx').on(table.category),
  index('workflow_templates_is_public_idx').on(table.isPublic),
  index('workflow_templates_is_official_idx').on(table.isOfficial),
  index('workflow_templates_author_idx').on(table.authorId),
  index('workflow_templates_usage_idx').on(table.usageCount),
]);

export type WorkflowTemplate = typeof workflowTemplates.$inferSelect;
export type NewWorkflowTemplate = typeof workflowTemplates.$inferInsert;
