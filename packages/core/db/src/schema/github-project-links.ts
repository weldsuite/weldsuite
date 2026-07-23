import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { githubConnections, type GithubOwnerType } from './github-connections';

/**
 * Sync direction for a linked GitHub Project.
 * Mirrors GithubSyncDirection on github-repo-links (kept local to avoid a
 * cross-file value import for a plain string union).
 */
export type GithubProjectSyncDirection = 'inbound' | 'outbound' | 'bidirectional';

/**
 * Mapping between one GitHub Project (v2) "Status" single-select option and a
 * WeldFlow stage. The Status field is user-defined per Project, so the option
 * ids/names are captured here for display and the WeldFlow `stageId` is the
 * target. `stageId` is nullable so an option can be left unmapped (items in
 * that status are skipped / left in the project default stage).
 */
export type GithubProjectStatusOptionMapping = {
  githubOptionId: string;
  githubOptionName: string;
  stageId: string | null;
};

/**
 * Links a GitHub Project (Projects v2) to a WeldFlow project.
 *
 * This is the unit of sync in the Projects-v2 model: each WeldFlow project maps
 * to exactly one GitHub Project, and many WeldFlow projects may map to Projects
 * that draw issues from the same repository. Projects v2 are org/user-owned and
 * referenced by their GraphQL node id (`projectV2NodeId`), not by repo.
 *
 * workspaceId is included for belt-and-suspenders tenant scoping even though
 * each workspace lives in its own database.
 */
export const githubProjectLinks = pgTable(
  'github_project_links',
  {
    // Base entity fields
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    // Tenant scope (belt-and-suspenders). Holds the Clerk org id (org_… ≈ 31-32 chars).
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

    // FK to GitHub App installation
    connectionId: varchar('connection_id', { length: 30 })
      .notNull()
      .references(() => githubConnections.id, { onDelete: 'cascade' }),

    // FK to WeldFlow project (varchar(255) to match projects.id).
    // One WeldFlow project maps to at most one GitHub Project.
    projectId: varchar('project_id', { length: 255 }).notNull(),

    // GitHub Project (v2) identification
    projectV2NodeId: text('project_v2_node_id').notNull(), // GraphQL global id, e.g. "PVT_kwDO..."
    projectV2Number: integer('project_v2_number').notNull(), // org/user-scoped number
    projectTitle: text('project_title'),

    // Owner of the Project (org or user account)
    ownerType: text('owner_type').notNull().$type<GithubOwnerType>(),
    ownerLogin: text('owner_login').notNull(),

    // Optional repository context — the repo whose issues this Project tracks.
    // Nullable because Projects v2 are not owned by a single repo.
    repoId: bigint('repo_id', { mode: 'number' }),
    repoFullName: text('repo_full_name'), // e.g. "owner/repo-name"

    // Status field mapping (Project "Status" single-select → WeldFlow stages)
    statusFieldId: text('status_field_id'), // GraphQL field id of the Status single-select
    statusOptionMap: jsonb('status_option_map')
      .$type<GithubProjectStatusOptionMapping[]>()
      .default([]),

    // Sync configuration
    syncIssues: boolean('sync_issues').notNull().default(true),
    syncDirection: text('sync_direction')
      .notNull()
      .default('bidirectional')
      .$type<GithubProjectSyncDirection>(),

    // Sync state
    lastSyncedAt: timestamp('last_synced_at'),
    lastError: text('last_error'),
    syncCursor: text('sync_cursor'), // opaque GraphQL pagination cursor for incremental sync
  },
  (table) => [
    index('github_project_links_workspace_id_idx').on(table.workspaceId),
    index('github_project_links_connection_id_idx').on(table.connectionId),
    // One GitHub Project per WeldFlow project.
    uniqueIndex('github_project_links_project_id_unique').on(table.projectId),
    // A Project (v2) is linked at most once per installation.
    uniqueIndex('github_project_links_connection_node_unique').on(
      table.connectionId,
      table.projectV2NodeId
    ),
  ]
);

export type GithubProjectLink = typeof githubProjectLinks.$inferSelect;
export type NewGithubProjectLink = typeof githubProjectLinks.$inferInsert;
