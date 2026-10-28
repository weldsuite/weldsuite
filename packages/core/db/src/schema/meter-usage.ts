/**
 * Usage meters: what a workspace used of each metered thing in a month. Master DB.
 *
 * One row per workspace, meter and UTC month. `used` counts units (workflow
 * runs, signature requests, …); `blocksCharged` is how many overage blocks
 * past the plan's allowance were already paid from the credit wallet, so a
 * block is charged once however many units fall into it. The meter catalog
 * (allowance per plan, block size, credits per block) lives in code:
 * `@weldsuite/credits/meters`.
 */

import { pgTable, varchar, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const workspaceMeterUsage = pgTable(
  'workspace_meter_usage',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // wmu_
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    /** Meter key from the catalog (`workflow_runs`, `sign_requests`, …). */
    meter: varchar('meter', { length: 50 }).notNull(),
    /** Calendar month, UTC, `YYYY-MM`. */
    period: varchar('period', { length: 7 }).notNull(),
    used: integer('used').notNull().default(0),
    /** Overage blocks already charged to the wallet this month. */
    blocksCharged: integer('blocks_charged').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_meter_usage_workspace_meter_period_idx').on(table.workspaceId, table.meter, table.period),
    index('workspace_meter_usage_workspace_period_idx').on(table.workspaceId, table.period),
  ],
);

export type WorkspaceMeterUsage = typeof workspaceMeterUsage.$inferSelect;
export type NewWorkspaceMeterUsage = typeof workspaceMeterUsage.$inferInsert;
