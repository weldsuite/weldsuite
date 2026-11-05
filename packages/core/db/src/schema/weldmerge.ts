/**
 * WeldMerge — pull requests and issues across git providers. Tenant DB.
 *
 * Issues are WeldMerge's own records (`merge_issues`), keyed per team as
 * `<team key>-<number>` (PLAT-209); the number comes from
 * `merge_teams.issue_counter`, bumped in the insert's transaction (ADR
 * MERGE-003).
 *
 * Pull requests stay on the provider: `merge_pull_requests` is a mirror written
 * only by sync (webhooks, adding a repository, Refresh). No route edits its
 * fields. `merge_issue_pull_requests` links the two, automatically from issue
 * keys in the branch, title or body, or by hand.
 *
 * Git-provider connections belong to WeldMerge (`merge_connections`, ADR
 * MERGE-002). For GitHub the row adopts the workspace's existing GitHub App
 * installation (`github_connections`); installation tokens are minted per
 * call, so `credentials` stays null.
 *
 * Member columns hold Clerk user ids. See design/modules/weldmerge.md in
 * weldsuite-documentation.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  doublePrecision,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export const MERGE_ISSUE_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
] as const;
export type MergeIssueStatus = (typeof MERGE_ISSUE_STATUSES)[number];

/** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const MERGE_ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type MergeIssuePriority = (typeof MERGE_ISSUE_PRIORITIES)[number];

export const MERGE_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'azure_devops'] as const;
export type MergeProvider = (typeof MERGE_PROVIDERS)[number];

export const MERGE_CONNECTION_STATUSES = ['active', 'suspended', 'revoked', 'needs_attention'] as const;
export type MergeConnectionStatus = (typeof MERGE_CONNECTION_STATUSES)[number];

/** How a repository's provider issues sync with WeldMerge issues. Phase 1 supports `off` only. */
export const MERGE_ISSUE_SYNC_MODES = ['two_way', 'import', 'off'] as const;
export type MergeIssueSyncMode = (typeof MERGE_ISSUE_SYNC_MODES)[number];

export const MERGE_PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const;
export type MergePullRequestState = (typeof MERGE_PULL_REQUEST_STATES)[number];

export const MERGE_CHECKS_STATUSES = ['pending', 'success', 'failure', 'neutral'] as const;
export type MergeChecksStatus = (typeof MERGE_CHECKS_STATUSES)[number];

export const MERGE_REVIEW_DECISIONS = ['approved', 'changes_requested', 'review_required'] as const;
export type MergeReviewDecision = (typeof MERGE_REVIEW_DECISIONS)[number];

export const MERGE_LINK_SOURCES = ['auto', 'manual'] as const;
export type MergeLinkSource = (typeof MERGE_LINK_SOURCES)[number];

/** A reviewer the provider asked for: a person (login) or a team (slug). */
export type MergeRequestedReviewer = {
  kind: 'user' | 'team';
  login: string;
  avatarUrl?: string | null;
  /** Filled when the login matches a member's `merge_provider_accounts` row. */
  userId?: string | null;
};

export type MergePullRequestLabel = { name: string; color?: string | null };

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/** A team that owns issues (Platform, API, Mobile). */
export const mergeTeams = pgTable(
  'merge_teams',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mtm_
    /** Upper-case letters and digits, 2–10 long; fixed once the team has issues. */
    key: varchar('key', { length: 10 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    color: varchar('color', { length: 20 }),
    /** Last issue number handed out; the next issue gets `issue_counter + 1`. */
    issueCounter: integer('issue_counter').notNull().default(0),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('merge_teams_key_idx').on(table.key).where(sql`${table.deletedAt} IS NULL`),
  ],
);

/** A team's time-boxed iteration. */
export const mergeCycles = pgTable(
  'merge_cycles',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mcy_
    teamId: varchar('team_id', { length: 30 }).notNull(),
    number: integer('number').notNull(),
    name: varchar('name', { length: 255 }),
    startsAt: date('starts_at').notNull(),
    endsAt: date('ends_at').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('merge_cycles_team_number_idx')
      .on(table.teamId, table.number)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

/** Issue labels; `team_id` null = available to every team. */
export const mergeLabels = pgTable(
  'merge_labels',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mlb_
    teamId: varchar('team_id', { length: 30 }),
    name: varchar('name', { length: 100 }).notNull(),
    color: varchar('color', { length: 20 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('merge_labels_team_idx').on(table.teamId)],
);

export const mergeIssues = pgTable(
  'merge_issues',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mis_
    teamId: varchar('team_id', { length: 30 }).notNull(),
    /** Unique per team; the key is `<team key>-<number>`. */
    number: integer('number').notNull(),

    title: varchar('title', { length: 500 }).notNull(),
    /** Markdown. */
    description: text('description'),
    status: varchar('status', { length: 20 }).$type<MergeIssueStatus>().notNull().default('backlog'),
    priority: integer('priority').$type<MergeIssuePriority>().notNull().default(0),

    assigneeUserId: varchar('assignee_user_id', { length: 255 }),
    creatorUserId: varchar('creator_user_id', { length: 255 }).notNull(),
    cycleId: varchar('cycle_id', { length: 30 }),
    parentIssueId: varchar('parent_issue_id', { length: 30 }),
    labelIds: jsonb('label_ids').$type<string[]>().notNull().default([]),
    estimate: integer('estimate'),
    dueDate: date('due_date'),
    /** Optional WeldFlow project this issue belongs to (a roadmap). */
    flowProjectId: varchar('flow_project_id', { length: 30 }),
    /** Order inside a board column; smaller first. */
    sortOrder: doublePrecision('sort_order').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('merge_issues_team_number_idx').on(table.teamId, table.number),
    index('merge_issues_team_status_idx').on(table.teamId, table.status),
    index('merge_issues_assignee_idx').on(table.assigneeUserId),
    index('merge_issues_cycle_idx').on(table.cycleId),
    index('merge_issues_parent_idx').on(table.parentIssueId),
    index('merge_issues_updated_idx').on(table.updatedAt),
  ],
);

export const mergeComments = pgTable(
  'merge_comments',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mcm_
    issueId: varchar('issue_id', { length: 30 }).notNull(),
    authorUserId: varchar('author_user_id', { length: 255 }).notNull(),
    /** Markdown. */
    body: text('body').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('merge_comments_issue_idx').on(table.issueId, table.createdAt)],
);

// ---------------------------------------------------------------------------
// Providers, repositories, pull requests
// ---------------------------------------------------------------------------

/** One connected provider account (a GitHub App installation, a GitLab group, …). */
export const mergeConnections = pgTable(
  'merge_connections',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mcn_
    provider: varchar('provider', { length: 20 }).$type<MergeProvider>().notNull(),
    /** GitHub: the installation id. */
    externalAccountId: varchar('external_account_id', { length: 255 }).notNull(),
    accountLogin: varchar('account_login', { length: 255 }),
    /** `user` or `organization` on GitHub; `group` on GitLab; … */
    accountType: varchar('account_type', { length: 30 }),
    /** Self-managed GitLab base URL, Azure DevOps organisation URL. Null for cloud GitHub. */
    host: varchar('host', { length: 500 }),
    status: varchar('status', { length: 20 }).$type<MergeConnectionStatus>().notNull().default('active'),
    /** Encrypted provider credentials; null for the GitHub App (tokens are minted per call). Never returned. */
    credentials: text('credentials'),
    credentialsExpireAt: timestamp('credentials_expire_at', { withTimezone: true }),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('merge_connections_account_idx')
      .on(table.provider, table.externalAccountId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

/** A repository WeldMerge tracks. */
export const mergeRepositories = pgTable(
  'merge_repositories',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mrp_
    connectionId: varchar('connection_id', { length: 30 }).notNull(),
    provider: varchar('provider', { length: 20 }).$type<MergeProvider>().notNull(),
    /** The provider's repository id. */
    externalId: varchar('external_id', { length: 255 }).notNull(),
    /** `owner/name`. */
    fullName: varchar('full_name', { length: 500 }).notNull(),
    defaultBranch: varchar('default_branch', { length: 255 }),
    private: boolean('private').notNull().default(true),
    url: varchar('url', { length: 1000 }),
    /** Team its pull requests show under. */
    teamId: varchar('team_id', { length: 30 }),
    issueSync: varchar('issue_sync', { length: 20 }).$type<MergeIssueSyncMode>().notNull().default('off'),
    prSync: boolean('pr_sync').notNull().default(true),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('merge_repositories_external_idx')
      .on(table.connectionId, table.externalId)
      .where(sql`${table.deletedAt} IS NULL`),
    index('merge_repositories_external_lookup_idx').on(table.provider, table.externalId),
  ],
);

/** Mirror of one pull request, written only by sync. */
export const mergePullRequests = pgTable(
  'merge_pull_requests',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mpr_
    repositoryId: varchar('repository_id', { length: 30 }).notNull(),
    provider: varchar('provider', { length: 20 }).$type<MergeProvider>().notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    number: integer('number').notNull(),

    title: varchar('title', { length: 1000 }).notNull(),
    body: text('body'),
    state: varchar('state', { length: 20 }).$type<MergePullRequestState>().notNull(),
    draft: boolean('draft').notNull().default(false),
    url: varchar('url', { length: 1000 }).notNull(),

    authorLogin: varchar('author_login', { length: 255 }),
    authorAvatarUrl: varchar('author_avatar_url', { length: 1000 }),
    /** Member whose provider account matches the author, when one does. */
    authorUserId: varchar('author_user_id', { length: 255 }),

    headRef: varchar('head_ref', { length: 500 }),
    baseRef: varchar('base_ref', { length: 500 }),
    headSha: varchar('head_sha', { length: 64 }),
    additions: integer('additions'),
    deletions: integer('deletions'),
    changedFiles: integer('changed_files'),
    checksStatus: varchar('checks_status', { length: 20 }).$type<MergeChecksStatus>(),
    reviewDecision: varchar('review_decision', { length: 30 }).$type<MergeReviewDecision>(),
    requestedReviewers: jsonb('requested_reviewers').$type<MergeRequestedReviewer[]>().notNull().default([]),
    labels: jsonb('labels').$type<MergePullRequestLabel[]>().notNull().default([]),

    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(),
    /** A webhook older than this is ignored. */
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }).notNull(),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merge_pull_requests_repo_number_idx').on(table.repositoryId, table.number),
    index('merge_pull_requests_state_idx').on(table.state, table.providerUpdatedAt),
    index('merge_pull_requests_author_idx').on(table.authorUserId),
  ],
);

/** Link between an issue and a pull request. */
export const mergeIssuePullRequests = pgTable(
  'merge_issue_pull_requests',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mip_
    issueId: varchar('issue_id', { length: 30 }).notNull(),
    pullRequestId: varchar('pull_request_id', { length: 30 }).notNull(),
    source: varchar('source', { length: 10 }).$type<MergeLinkSource>().notNull(),
    /** Merging the pull request moves the issue to Done. False after "refs", "part of", "related to". */
    closes: boolean('closes').notNull().default(true),

    createdByUserId: varchar('created_by_user_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merge_issue_pull_requests_pair_idx').on(table.issueId, table.pullRequestId),
    index('merge_issue_pull_requests_pr_idx').on(table.pullRequestId),
  ],
);

/** A member's login on a provider: "needs your review" and "yours" match on it. */
export const mergeProviderAccounts = pgTable(
  'merge_provider_accounts',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mpa_
    userId: varchar('user_id', { length: 255 }).notNull(),
    provider: varchar('provider', { length: 20 }).$type<MergeProvider>().notNull(),
    /** Stored lower-case; provider logins are case-insensitive. */
    login: varchar('login', { length: 255 }).notNull(),
    externalUserId: varchar('external_user_id', { length: 255 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merge_provider_accounts_login_idx').on(table.provider, table.login),
    uniqueIndex('merge_provider_accounts_user_idx').on(table.userId, table.provider),
  ],
);
