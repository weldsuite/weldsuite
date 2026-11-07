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

/** How a repository's provider issues sync with WeldMerge issues (GitHub and GitLab). */
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

/** Where a comment was written: in WeldMerge, or on the provider and synced in. */
export const MERGE_COMMENT_SOURCES = ['weldmerge', 'provider'] as const;
export type MergeCommentSource = (typeof MERGE_COMMENT_SOURCES)[number];

export const MERGE_EXTERNAL_ISSUE_STATES = ['open', 'closed'] as const;
export type MergeExternalIssueState = (typeof MERGE_EXTERNAL_ISSUE_STATES)[number];

/** Which side wrote an externally synced issue last (loop guard). */
export const MERGE_EXTERNAL_WRITERS = ['weldmerge', 'provider'] as const;
export type MergeExternalWriter = (typeof MERGE_EXTERNAL_WRITERS)[number];

export const MERGE_RELEASE_STATUSES = ['draft', 'shipped'] as const;
export type MergeReleaseStatus = (typeof MERGE_RELEASE_STATUSES)[number];

/** WeldSuite records an issue can be linked to. */
export const MERGE_RECORD_TYPES = ['desk_ticket', 'crm_company', 'chat_channel'] as const;
export type MergeRecordType = (typeof MERGE_RECORD_TYPES)[number];

/** Events a chat subscription can post about. */
export const MERGE_CHAT_EVENTS = [
  'review_requested',
  'checks_failed',
  'pull_request_merged',
  'issue_created',
  'issue_done',
  'release_shipped',
  'daily_digest',
] as const;
export type MergeChatEvent = (typeof MERGE_CHAT_EVENTS)[number];

/** Master `merge_provider_index.kind`. */
export const MERGE_PROVIDER_INDEX_KINDS = ['installation', 'webhook'] as const;
export type MergeProviderIndexKind = (typeof MERGE_PROVIDER_INDEX_KINDS)[number];

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
    /** A WeldAgent agent the issue is assigned to. */
    agentId: varchar('agent_id', { length: 30 }),
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
    /** Null for a provider comment written by someone who isn't a member. */
    authorUserId: varchar('author_user_id', { length: 255 }),
    /** Markdown. */
    body: text('body').notNull(),
    /** The provider's comment id, for comments synced with a provider issue. */
    externalId: varchar('external_id', { length: 255 }),
    externalAuthorLogin: varchar('external_author_login', { length: 255 }),
    externalAuthorAvatarUrl: varchar('external_author_avatar_url', { length: 1000 }),
    source: varchar('source', { length: 20 }).$type<MergeCommentSource>().notNull().default('weldmerge'),

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
    /** Encrypted. GitHub's per-installation fallback webhook secret. Never returned. */
    webhookSecret: text('webhook_secret'),
    /** GitHub App slug the installation belongs to. */
    appSlug: varchar('app_slug', { length: 255 }),
    scopes: jsonb('scopes').$type<string[]>(),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Who authorized an OAuth connection (the provider login). */
    oauthUserLogin: varchar('oauth_user_login', { length: 255 }),

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
    /** Bitbucket workspace slug, Azure DevOps project name, GitLab namespace path. */
    externalProject: varchar('external_project', { length: 500 }),
    /** The provider's hook / subscription id. */
    webhookId: varchar('webhook_id', { length: 255 }),
    /** Random routing key in the webhook URL; unique among non-null. */
    webhookKey: varchar('webhook_key', { length: 64 }),
    /** Encrypted. Verifies this repository's provider webhooks. Never returned. */
    webhookSecret: text('webhook_secret'),

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
    uniqueIndex('merge_repositories_webhook_key_idx')
      .on(table.webhookKey)
      .where(sql`${table.webhookKey} IS NOT NULL`),
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
    /** A removed automatic link stays removed: sync skips dismissed pairs. */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),

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
    /** Self-managed GitLab base URL, Azure DevOps org URL; null for cloud. */
    host: varchar('host', { length: 500 }),
    /** Encrypted member token JSON `{accessToken, refreshToken?, expiresAt?, tokenType?}`. Never returned. */
    credentials: text('credentials'),
    credentialsExpireAt: timestamp('credentials_expire_at', { withTimezone: true }),
    /** Set when linked through OAuth; null = a typed login. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    avatarUrl: varchar('avatar_url', { length: 1000 }),
    displayName: varchar('display_name', { length: 255 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merge_provider_accounts_login_idx').on(
      table.provider,
      sql`coalesce(${table.host}, '')`,
      table.login,
    ),
    uniqueIndex('merge_provider_accounts_user_idx').on(
      table.userId,
      table.provider,
      sql`coalesce(${table.host}, '')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Provider issue sync, inbox state
// ---------------------------------------------------------------------------

/** Link between a WeldMerge issue and the provider issue it syncs with. */
export const mergeExternalIssues = pgTable(
  'merge_external_issues',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mxi_
    issueId: varchar('issue_id', { length: 30 }).notNull(),
    repositoryId: varchar('repository_id', { length: 30 }).notNull(),
    provider: varchar('provider', { length: 20 }).$type<MergeProvider>().notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    number: integer('number').notNull(),
    url: varchar('url', { length: 1000 }).notNull(),
    state: varchar('state', { length: 10 }).$type<MergeExternalIssueState>().notNull(),
    /** sha-256 of the synced fields: an event that matches it is an echo and is ignored. */
    checksum: varchar('checksum', { length: 64 }).notNull(),
    lastWriter: varchar('last_writer', { length: 20 }).$type<MergeExternalWriter>().notNull(),
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merge_external_issues_issue_idx').on(table.issueId),
    uniqueIndex('merge_external_issues_repo_number_idx').on(table.repositoryId, table.number),
  ],
);

/** A member's own state for an inbox item (the inbox itself is derived). */
export const mergeInboxStates = pgTable(
  'merge_inbox_states',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mib_
    userId: varchar('user_id', { length: 255 }).notNull(),
    /** The inbox item's id. */
    itemKey: varchar('item_key', { length: 200 }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('merge_inbox_states_user_item_idx').on(table.userId, table.itemKey)],
);

// ---------------------------------------------------------------------------
// Releases, record links, chat subscriptions
// ---------------------------------------------------------------------------

export const mergeReleases = pgTable(
  'merge_releases',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mrl_
    teamId: varchar('team_id', { length: 30 }).notNull(),
    repositoryId: varchar('repository_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    version: varchar('version', { length: 100 }),
    baseRef: varchar('base_ref', { length: 500 }),
    headRef: varchar('head_ref', { length: 500 }),
    status: varchar('status', { length: 20 }).$type<MergeReleaseStatus>().notNull().default('draft'),
    /** Markdown. */
    notes: text('notes'),
    notesGeneratedAt: timestamp('notes_generated_at', { withTimezone: true }),
    knowledgePageId: varchar('knowledge_page_id', { length: 30 }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('merge_releases_team_idx').on(table.teamId, table.status),
    index('merge_releases_repository_idx').on(table.repositoryId),
  ],
);

export const mergeReleasePullRequests = pgTable(
  'merge_release_pull_requests',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mrr_
    releaseId: varchar('release_id', { length: 30 }).notNull(),
    pullRequestId: varchar('pull_request_id', { length: 30 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merge_release_pull_requests_pair_idx').on(table.releaseId, table.pullRequestId),
    index('merge_release_pull_requests_pr_idx').on(table.pullRequestId),
  ],
);

/** An issue linked to a record elsewhere in WeldSuite (a ticket, a company, a chat channel). */
export const mergeRecordLinks = pgTable(
  'merge_record_links',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mrk_
    issueId: varchar('issue_id', { length: 30 }).notNull(),
    recordType: varchar('record_type', { length: 30 }).$type<MergeRecordType>().notNull(),
    recordId: varchar('record_id', { length: 255 }).notNull(),
    /** Cached label of the record. */
    title: varchar('title', { length: 500 }),
    createdByUserId: varchar('created_by_user_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merge_record_links_unique_idx').on(table.issueId, table.recordType, table.recordId),
    index('merge_record_links_record_idx').on(table.recordType, table.recordId),
  ],
);

/** A chat channel that gets posts about a team's or repository's activity. */
export const mergeChatSubscriptions = pgTable(
  'merge_chat_subscriptions',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // mcs_
    channelId: varchar('channel_id', { length: 30 }).notNull(),
    teamId: varchar('team_id', { length: 30 }),
    repositoryId: varchar('repository_id', { length: 30 }),
    events: jsonb('events').$type<MergeChatEvent[]>().notNull().default([]),
    /** UTC hour (0-23) the daily digest is posted. */
    digestHour: integer('digest_hour').notNull().default(9),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('merge_chat_subscriptions_channel_idx').on(table.channelId),
    index('merge_chat_subscriptions_team_idx').on(table.teamId),
    index('merge_chat_subscriptions_repository_idx').on(table.repositoryId),
  ],
);

export type MergeExternalIssue = typeof mergeExternalIssues.$inferSelect;
export type MergeInboxState = typeof mergeInboxStates.$inferSelect;
export type MergeRelease = typeof mergeReleases.$inferSelect;
export type MergeReleasePullRequest = typeof mergeReleasePullRequests.$inferSelect;
export type MergeRecordLink = typeof mergeRecordLinks.$inferSelect;
export type MergeChatSubscription = typeof mergeChatSubscriptions.$inferSelect;
