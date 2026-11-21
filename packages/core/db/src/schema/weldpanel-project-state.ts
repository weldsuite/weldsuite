/**
 * WeldPanel's project state on the Kubernetes editions (EU, self-hosted; ADR
 * EVT-019, weldsuite-documentation/plans/weldpanel-eu.md "What the Durable
 * Objects hold on Global"). Tenant DB. Unused on Global, where the
 * PanelProject Durable Object (apps/workers/panel-ingest, ADR PANEL-004) keeps
 * the same state in SQLite; these tables are its `people`, `identities`,
 * `groups`, `group_types`, `erased` and `meta` tables, one set per project.
 *
 * Nothing here is written at ingest: the collector publishes the operations
 * to NATS and `weldsuite consume` (`panel-state`) applies them in stream
 * order with the object's rules, opening only the producing workspace's
 * database (ADR DATA-008). The Rust panel routes read them and write the
 * rest (erasure, group types, group deletes). Every row is scoped by
 * workspace and project. The live view is not here: it is a Valkey sorted
 * set per project.
 */

import { pgTable, varchar, text, json, timestamp, integer, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';

/** A profile or group property value (`PanelPropertyValue`). */
export type PanelStatePropertyValue = string | number | boolean | null;

/** The latest profile of each identified user (the object's `people`). */
export const panelPeople = pgTable(
  'panel_people',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnpe_
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    userId: text('user_id').notNull(),
    /** The `$email` property, trimmed and lower-cased, if set. */
    email: varchar('email', { length: 320 }),
    /** The `$name` property (its first 255 characters), if set. */
    name: text('name'),
    /** The properties as the object serialises them (`json`, not `jsonb`: the text is kept as written). */
    properties: json('properties').$type<Record<string, PanelStatePropertyValue>>().notNull(),
    firstSeen: timestamp('first_seen', { withTimezone: true, precision: 3 }).notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('panel_people_user_idx').on(table.workspaceId, table.projectId, table.userId),
    index('panel_people_last_seen_idx').on(table.workspaceId, table.projectId, table.lastSeen.desc()),
    index('panel_people_email_idx').on(table.workspaceId, table.projectId, table.email),
  ],
);

/** Anonymous id → user id. An anonymous id links to one user: the first link wins. */
export const panelIdentityLinks = pgTable(
  'panel_identity_links',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnil_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    anonId: text('anon_id').notNull(),
    userId: text('user_id').notNull(),
    /** When the link was made, ISO 8601 as the collector sent it: a person's anonymous ids are listed in this order. */
    ts: text('ts').notNull(),
  },
  (table) => [
    uniqueIndex('panel_identity_links_anon_idx').on(table.workspaceId, table.projectId, table.anonId),
    index('panel_identity_links_user_idx').on(table.workspaceId, table.projectId, table.userId),
  ],
);

/** Group profiles: a company, an account, a workspace (the object's `groups`). */
export const panelGroups = pgTable(
  'panel_groups',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pngr_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    groupType: varchar('group_type', { length: 32 }).notNull(),
    groupKey: varchar('group_key', { length: 255 }).notNull(),
    properties: json('properties').$type<Record<string, PanelStatePropertyValue>>().notNull(),
    firstSeen: timestamp('first_seen', { withTimezone: true, precision: 3 }).notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('panel_groups_key_idx').on(table.workspaceId, table.projectId, table.groupType, table.groupKey),
    index('panel_groups_last_seen_idx').on(table.workspaceId, table.projectId, table.groupType, table.lastSeen.desc()),
  ],
);

/**
 * The group types the project collects, at most `MAX_GROUP_TYPES` (the
 * object's `group_types`): a type takes the next position the first time
 * data names it while slots are free. Not `panel_group_types`, which holds
 * the types' display names and CRM link.
 */
export const panelGroupSlots = pgTable(
  'panel_group_slots',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pngs_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    groupType: varchar('group_type', { length: 32 }).notNull(),
    position: integer('position').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [uniqueIndex('panel_group_slots_type_idx').on(table.workspaceId, table.projectId, table.groupType)],
);

/**
 * Ids erased but not yet rewritten out of the Iceberg tables: every query
 * excludes them until the nightly maintenance job has rewritten their rows
 * (`panel_erasure_ledger` in the master DB) and released them here.
 */
export const panelErasedIds = pgTable(
  'panel_erased_ids',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnei_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    erasedId: text('erased_id').notNull(),
    erasedAt: timestamp('erased_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [uniqueIndex('panel_erased_ids_id_idx').on(table.workspaceId, table.projectId, table.erasedId)],
);

/** One row per project: the object's `meta`, and where the applier is in the operations stream. */
export const panelProjectMeta = pgTable(
  'panel_project_meta',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnpm_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    /** The change counter: every `people_v1` / `groups_v1` row takes a higher number than any before it. */
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    /** The operations stream `applied_seq` counts in: its name and creation time. */
    appliedStream: varchar('applied_stream', { length: 255 }),
    /** The stream sequence of the last operation applied: a redelivery at or below it is skipped. */
    appliedSeq: bigint('applied_seq', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('panel_project_meta_project_idx').on(table.workspaceId, table.projectId)],
);

export type PanelPersonStateRow = typeof panelPeople.$inferSelect;
export type NewPanelPersonStateRow = typeof panelPeople.$inferInsert;
export type PanelIdentityLinkRow = typeof panelIdentityLinks.$inferSelect;
export type NewPanelIdentityLinkRow = typeof panelIdentityLinks.$inferInsert;
export type PanelGroupStateRow = typeof panelGroups.$inferSelect;
export type NewPanelGroupStateRow = typeof panelGroups.$inferInsert;
export type PanelGroupSlotRow = typeof panelGroupSlots.$inferSelect;
export type NewPanelGroupSlotRow = typeof panelGroupSlots.$inferInsert;
export type PanelErasedIdRow = typeof panelErasedIds.$inferSelect;
export type NewPanelErasedIdRow = typeof panelErasedIds.$inferInsert;
export type PanelProjectMetaRow = typeof panelProjectMeta.$inferSelect;
export type NewPanelProjectMetaRow = typeof panelProjectMeta.$inferInsert;
