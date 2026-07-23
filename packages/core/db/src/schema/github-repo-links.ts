import {
  pgTable,
  varchar,
  text,
  timestamp,
  bigint,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { githubConnections } from './github-connections';

/**
 * Sync direction for a linked repository
 */
export type GithubSyncDirection = 'inbound' | 'outbound' | 'bidirectional';

/**
 * Links a GitHub repository to a WeldFlow project.
 * One connection can have many repo links (multiple repos per installation).
 * One project can link to multiple repos.
 *
 * workspaceId is included for belt-and-suspenders tenant scoping even
 * though each workspace lives in its own database.
 */
export const githubRepoLinks = pgTable(
  'github_repo_links',
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

    // FK to WeldFlow project (varchar(255) to match projects.id)
    projectId: varchar('project_id', { length: 255 }),

    // GitHub repository identification
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    repoFullName: text('repo_full_name').notNull(), // e.g. "owner/repo-name"

    // Repository metadata
    defaultBranch: text('default_branch'),

    // Sync configuration
    syncIssues: boolean('sync_issues').notNull().default(true),
    syncDirection: text('sync_direction')
      .notNull()
      .default('bidirectional')
      .$type<GithubSyncDirection>(),

    // Sync state
    lastSyncedAt: timestamp('last_synced_at'),
    syncCursor: text('sync_cursor'), // opaque pagination cursor for incremental sync
  },
  (table) => [
    index('github_repo_links_workspace_id_idx').on(table.workspaceId),
    index('github_repo_links_project_id_idx').on(table.projectId),
    index('github_repo_links_connection_id_idx').on(table.connectionId),
    uniqueIndex('github_repo_links_connection_repo_unique').on(
      table.connectionId,
      table.repoId
    ),
  ]
);

export type GithubRepoLink = typeof githubRepoLinks.$inferSelect;
export type NewGithubRepoLink = typeof githubRepoLinks.$inferInsert;
