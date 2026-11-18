/**
 * WeldPanel's store on the Kubernetes editions (EU, self-hosted; ADR EVT-019).
 * Master DB. Unused on Global.
 *
 * `iceberg_tables` and `iceberg_namespace_properties` are the Iceberg catalog
 * of the Rust `weldsuite-lakehouse` crate: it reads and writes them itself and
 * commits a table by a compare-and-swap on `metadata_location`. Their layout is
 * the Iceberg JDBC/SQL catalog's, so other Iceberg tools can open the catalog.
 * The primary keys are named explicitly because Drizzle's default name for
 * `iceberg_namespace_properties` would pass Postgres's 63-character limit.
 *
 * `panel_erasure_ledger` holds the erasures waiting for the nightly Iceberg
 * rewrite: the Kubernetes counterpart of Global's MaintenanceLedger Durable
 * Object (apps/workers/panel-maintenance/src/ledger.ts). One row per project
 * and erased id. A repeated request sets `requested_at` again and clears
 * `applied_at`, so a rewrite that started before it doesn't count.
 * `weldsuite cron panel-maintenance` reads the pending rows here and never
 * iterates tenant databases.
 */

import { sql } from 'drizzle-orm';
import { pgTable, varchar, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

export const icebergTables = pgTable(
  'iceberg_tables',
  {
    catalogName: varchar('catalog_name', { length: 255 }).notNull(),
    tableNamespace: varchar('table_namespace', { length: 255 }).notNull(),
    tableName: varchar('table_name', { length: 255 }).notNull(),
    /** The table's current metadata file; a commit swaps it only if it is still the one read. */
    metadataLocation: varchar('metadata_location', { length: 1000 }),
    previousMetadataLocation: varchar('previous_metadata_location', { length: 1000 }),
    /** `TABLE` or `VIEW`; null is read as a table. */
    icebergType: varchar('iceberg_type', { length: 5 }),
  },
  (table) => [
    primaryKey({ name: 'iceberg_tables_pkey', columns: [table.catalogName, table.tableNamespace, table.tableName] }),
  ],
);

export const icebergNamespaceProperties = pgTable(
  'iceberg_namespace_properties',
  {
    catalogName: varchar('catalog_name', { length: 255 }).notNull(),
    namespace: varchar('namespace', { length: 255 }).notNull(),
    propertyKey: varchar('property_key', { length: 255 }).notNull(),
    propertyValue: varchar('property_value', { length: 1000 }),
  },
  (table) => [
    primaryKey({
      name: 'iceberg_namespace_properties_pkey',
      columns: [table.catalogName, table.namespace, table.propertyKey],
    }),
  ],
);

export const panelErasureLedger = pgTable(
  'panel_erasure_ledger',
  {
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    /** The tenant `panel_projects.id`. */
    projectId: varchar('project_id', { length: 30 }).notNull(),
    /** A distinct id, anonymous id or user id. */
    erasedId: text('erased_id').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the rewrite that covered it finished; null while pending. */
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.erasedId] }),
    index('panel_erasure_ledger_pending_idx').on(table.requestedAt).where(sql`${table.appliedAt} IS NULL`),
    index('panel_erasure_ledger_workspace_idx').on(table.workspaceId),
  ],
);

export type IcebergTableRow = typeof icebergTables.$inferSelect;
export type NewIcebergTableRow = typeof icebergTables.$inferInsert;
export type IcebergNamespacePropertyRow = typeof icebergNamespaceProperties.$inferSelect;
export type NewIcebergNamespacePropertyRow = typeof icebergNamespaceProperties.$inferInsert;
export type PanelErasureLedgerRow = typeof panelErasureLedger.$inferSelect;
export type NewPanelErasureLedgerRow = typeof panelErasureLedger.$inferInsert;
