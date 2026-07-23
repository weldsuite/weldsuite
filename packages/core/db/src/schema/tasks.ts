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
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Task types and statuses matching backend
export type TaskType = 'task' | 'bug' | 'story' | 'epic' | 'feature' | 'improvement' | 'subtask';
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'testing' | 'done' | 'cancelled';
export type Priority = 'critical' | 'high' | 'medium' | 'low' | 'none';

export const tasks = pgTable('tasks', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // References (all optional — task can be standalone, project-linked, CRM-linked, or both)
  projectId: varchar('project_id', { length: 255 }),
  sprintId: varchar('sprint_id', { length: 255 }),
  milestoneId: varchar('milestone_id', { length: 255 }),
  parentTaskId: varchar('parent_task_id', { length: 255 }),
  // Pipeline stage this task belongs to (pipeline view uses this; status is the system-wide semantic value)
  stageId: varchar('stage_id', { length: 255 }),

  // CRM links (legacy — kept during Companies/People migration)
  customerId: varchar('customer_id', { length: 30 }),
  contactId: varchar('contact_id', { length: 30 }),
  // New — populated by migration backfill.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),

  // Basic info
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  key: varchar('key', { length: 50 }),

  // Human-friendly per-workspace sequential number (displayed as TASK-<number>).
  // Server-assigned on create; unique within the tenant DB. Nullable so pre-backfill
  // rows stay valid until the one-time backfill runs.
  number: integer('number'),

  // Status & Priority
  status: varchar('status', { length: 50 }).notNull().default('todo'),
  priority: varchar('priority', { length: 20 }).notNull().default('medium'),
  progress: numeric('progress', { precision: 5, scale: 2 }).notNull().default('0'),

  // Type & Category
  type: varchar('type', { length: 50 }).default('task'),
  category: varchar('category', { length: 100 }),

  // Labels & Tags
  tags: jsonb('tags').$type<string[]>(),
  labels: jsonb('labels').$type<string[]>(),

  // Assignment
  assigneeId: varchar('assignee_id', { length: 255 }),
  assigneeIds: jsonb('assignee_ids').$type<string[]>(),
  reporterId: varchar('reporter_id', { length: 255 }),
  watchers: jsonb('watchers').$type<string[]>(),

  // Dates
  startDate: timestamp('start_date'),
  dueDate: timestamp('due_date'),
  completedDate: timestamp('completed_date'),

  // Time tracking
  estimatedHours: numeric('estimated_hours', { precision: 10, scale: 2 }),
  actualHours: numeric('actual_hours', { precision: 10, scale: 2 }),
  duration: integer('duration'), // minutes
  storyPoints: integer('story_points'),

  // Dependencies
  dependsOn: jsonb('depends_on').$type<string[]>(),
  blocks: jsonb('blocks').$type<string[]>(),

  // Position
  position: integer('position').notNull().default(0),
  boardPosition: integer('board_position'),

  // Additional fields
  acceptanceCriteria: text('acceptance_criteria'),
  resolution: varchar('resolution', { length: 255 }),
  isBillable: boolean('is_billable').notNull().default(true),

  // Recurrence
  repeat: jsonb('repeat').$type<{
    frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
    interval?: number;
    unit?: 'days' | 'weeks' | 'months' | 'years';
  }>(),

  // Calendar sync
  calendarEventId: varchar('calendar_event_id', { length: 30 }),

  // GitHub integration — set when this task is synced with a GitHub issue
  githubIssueNumber: integer('github_issue_number'),
  githubRepoLinkId: varchar('github_repo_link_id', { length: 30 }),

  // Custom fields
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),
}, (table) => [
  index('tasks_project_idx').on(table.projectId),
  index('tasks_assignee_idx').on(table.assigneeId),
  index('tasks_status_idx').on(table.status),
  index('tasks_sprint_idx').on(table.sprintId),
  index('tasks_milestone_idx').on(table.milestoneId),
  index('tasks_parent_idx').on(table.parentTaskId),
  index('tasks_customer_idx').on(table.customerId),
  index('tasks_contact_idx').on(table.contactId),
  index('tasks_counterparty_idx').on(table.counterpartyId),
  index('tasks_person_idx').on(table.personId),
  index('tasks_github_repo_link_idx').on(table.githubRepoLinkId),
  uniqueIndex('tasks_number_unique').on(table.number),
]);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
