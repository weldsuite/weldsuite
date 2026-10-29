import { pgTable, varchar, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Feature flag values for the Kubernetes editions (EU, self-hosted), where
 * there is no Cloudflare Flagship. The Rust backend reads the whole table with
 * `FEATURE_FLAGS=master-db` (`MasterDbFlagSource` in
 * `rust/crates/adapters-oss/src/flags.rs`) and refreshes it every 30 seconds.
 *
 * A row with `workspace_id` set (a `workspaces.id`, or the Clerk org id) wins
 * over the row for every workspace (`workspace_id` null); with neither, the
 * flag's catalog default in `@weldsuite/feature-flags` applies. Flagship's
 * targeting rules (by user, plan or %-rollout) have no equivalent here.
 *
 * Global never reads it: its workers evaluate flags in Flagship.
 */
export const featureFlagOverrides = pgTable(
  'feature_flag_overrides',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // ffo_
    /** A key of `FLAGS` in `@weldsuite/feature-flags`. */
    flagKey: varchar('flag_key', { length: 100 }).notNull(),
    /** `workspaces.id` or Clerk org id; null = every workspace. */
    workspaceId: varchar('workspace_id', { length: 255 }),
    /** The flag's value, of the type its catalog entry declares. */
    value: jsonb('value').$type<unknown>().notNull(),
    updatedBy: varchar('updated_by', { length: 255 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One value per flag per workspace, and one for every workspace (null).
    unique('feature_flag_overrides_flag_workspace_unique')
      .on(table.flagKey, table.workspaceId)
      .nullsNotDistinct(),
  ],
);

export type FeatureFlagOverride = typeof featureFlagOverrides.$inferSelect;
export type NewFeatureFlagOverride = typeof featureFlagOverrides.$inferInsert;
