import {
  pgTable,
  varchar,
  timestamp,
  integer,
  bigint,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { githubProjectLinks } from './github-project-links';

/**
 * Which side of the sync wrote last
 */
export type GithubLastWriterSide = 'task' | 'issue';

/**
 * Bidirectional sync map between GitHub Project (v2) items and WeldFlow tasks.
 *
 * Each row represents a live mapping between one Project item (which wraps a
 * GitHub issue) in a specific project link and one WeldFlow task. The map is
 * used to:
 *   - Detect which side changed since the last sync
 *   - Identify conflicts (both sides changed) and apply most-recent-wins
 *   - Skip no-op events
 *
 * Projects v2 are manipulated at the *item* level (e.g. to set the Status
 * field), so `projectItemNodeId` is stored alongside the underlying issue
 * identifiers. The same issue can belong to several Projects, so it may appear
 * once per project link — each as its own task — which is why the unique key is
 * scoped to the project link rather than the issue alone.
 *
 * workspaceId is included for belt-and-suspenders tenant scoping even though
 * each workspace lives in its own database.
 */
export const githubIssueSyncMap = pgTable(
  'github_issue_sync_map',
  {
    // Base entity fields
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    // Tenant scope (belt-and-suspenders). Holds the Clerk org id (org_… ≈ 31-32 chars).
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

    // FK to the project link that owns this mapping
    projectLinkId: varchar('project_link_id', { length: 30 })
      .notNull()
      .references(() => githubProjectLinks.id, { onDelete: 'cascade' }),

    // FK to the WeldFlow task (varchar(255) to match tasks.id)
    taskId: varchar('task_id', { length: 255 }).notNull(),

    // GitHub Project item (Projects v2) — the unit we mutate for Status changes
    projectItemNodeId: text('project_item_node_id').notNull(),

    // Underlying GitHub issue identifiers
    issueNodeId: text('issue_node_id'), // GraphQL global id of the issue
    issueNumber: integer('issue_number').notNull(), // issue number within the repo
    repoId: bigint('repo_id', { mode: 'number' }), // repo the issue lives in

    // Sync watermarks — used for conflict detection
    lastSyncedTaskUpdatedAt: timestamp('last_synced_task_updated_at'),
    lastSyncedIssueUpdatedAt: timestamp('last_synced_issue_updated_at'),

    // Which side was the source of truth on the last sync pass
    lastWriterSide: text('last_writer_side').$type<GithubLastWriterSide>(),
  },
  (table) => [
    index('github_issue_sync_map_workspace_id_idx').on(table.workspaceId),
    index('github_issue_sync_map_project_link_id_idx').on(table.projectLinkId),
    // One mapping per item within a project link.
    uniqueIndex('github_issue_sync_map_link_item_unique').on(
      table.projectLinkId,
      table.projectItemNodeId
    ),
    // A task corresponds to exactly one Project item.
    uniqueIndex('github_issue_sync_map_task_id_unique').on(table.taskId),
  ]
);

export type GithubIssueSyncMap = typeof githubIssueSyncMap.$inferSelect;
export type NewGithubIssueSyncMap = typeof githubIssueSyncMap.$inferInsert;
