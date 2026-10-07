import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import type { TriggerConfig, WorkflowStep, WorkflowSettings } from './workflows';

/**
 * Why a snapshot was taken — surfaced in the editor's History panel.
 *   - activated: the workflow just transitioned draft/paused -> active
 *   - saved: an already-active workflow was saved with a meaningful change
 *   - restored: a previous version was restored (itself becomes a new version)
 */
export type WorkflowVersionReason = 'activated' | 'saved' | 'restored';

/**
 * Point-in-time snapshots of a `workflows` row, taken on activation and on
 * every save of an already-active workflow (not on every draft autosave —
 * see services/workflow-versions.ts in connect-api for the exact policy).
 * Restoring an old version writes a NEW version on top; nothing is ever
 * overwritten or deleted here.
 */
export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    workflowId: varchar('workflow_id', { length: 30 }).notNull(),
    // Monotonically increasing per workflowId, starting at 1.
    version: integer('version').notNull(),

    // Snapshot of the workflow at this point in time.
    name: varchar('name', { length: 255 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    triggers: jsonb('triggers').$type<TriggerConfig[]>(),
    steps: jsonb('steps').$type<WorkflowStep[]>(),
    settings: jsonb('settings').$type<WorkflowSettings>(),

    createdBy: varchar('created_by', { length: 255 }),
    reason: varchar('reason', { length: 20 }).notNull().$type<WorkflowVersionReason>(),
    // Set when `reason` is 'restored': the version number this snapshot restored from.
    restoredFromVersion: integer('restored_from_version'),
    note: text('note'),
  },
  (table) => [
    index('workflow_versions_workflow_idx').on(table.workflowId),
    unique('workflow_versions_workflow_version_unique').on(table.workflowId, table.version),
  ],
);

export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type NewWorkflowVersion = typeof workflowVersions.$inferInsert;
