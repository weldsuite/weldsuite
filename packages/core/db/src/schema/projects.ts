import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  numeric,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Matches existing .NET Project entity exactly
export const projects = pgTable('projects', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  deletedAt: timestamp('deleted_at'),

  // Project fields
  administrationId: varchar('administration_id', { length: 255 }),
  code: varchar('code', { length: 50 }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  customerId: varchar('customer_id', { length: 255 }),
  // New — populated by migration backfill.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  projectManagerId: varchar('project_manager_id', { length: 255 }),
  status: varchar('status', { length: 50 }).notNull().default('Planning'),

  // Dates
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  actualStartDate: timestamp('actual_start_date'),
  actualEndDate: timestamp('actual_end_date'),

  // Budget
  budgetedHours: numeric('budgeted_hours', { precision: 18, scale: 2 }),
  budgetedAmount: numeric('budgeted_amount', { precision: 18, scale: 2 }),
  actualHours: numeric('actual_hours', { precision: 18, scale: 2 }),
  actualAmount: numeric('actual_amount', { precision: 18, scale: 2 }),

  // Billing
  billingMethod: varchar('billing_method', { length: 50 }),
  hourlyRate: numeric('hourly_rate', { precision: 18, scale: 2 }),

  // Flags
  isBillable: boolean('is_billable').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  trackTime: boolean('track_time').notNull().default(true),

  // Project management
  key: varchar('key', { length: 50 }),
  priority: varchar('priority', { length: 50 }),
  type: varchar('type', { length: 50 }),
  health: varchar('health', { length: 50 }),
  progress: numeric('progress', { precision: 5, scale: 2 }).notNull().default('0'),
  methodology: varchar('methodology', { length: 50 }),
  visibility: varchar('visibility', { length: 50 }),
  leaderId: varchar('leader_id', { length: 255 }),
  clientId: varchar('client_id', { length: 255 }),
  budgetCurrency: varchar('budget_currency', { length: 10 }),

  // Counters
  totalTasks: integer('total_tasks').notNull().default(0),
  completedTasks: integer('completed_tasks').notNull().default(0),
  openTasks: integer('open_tasks').notNull().default(0),
  totalMilestones: integer('total_milestones').notNull().default(0),
  completedMilestones: integer('completed_milestones').notNull().default(0),

  // Customization
  categoryId: varchar('category_id', { length: 255 }),
  color: varchar('color', { length: 50 }),
  icon: varchar('icon', { length: 255 }),
  coverImage: varchar('cover_image', { length: 500 }),
  settings: jsonb('settings').$type<Record<string, unknown>>(),

  // JSON data
  whiteboardData: text('whiteboard_data'),
  documentData: text('document_data'),
  goalsData: text('goals_data'),
}, (table) => [
  index('projects_customer_idx').on(table.customerId),
  index('projects_counterparty_idx').on(table.counterpartyId),
  index('projects_status_idx').on(table.status),
  index('projects_is_active_idx').on(table.isActive),
]);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
