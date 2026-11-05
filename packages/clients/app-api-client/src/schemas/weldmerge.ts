/**
 * WeldMerge — the contract between merge-api (and its Rust twin,
 * rust/modules/merge) and the platform. Zod v3.
 *
 * Phase 1: teams, issues, labels, cycles, comments; GitHub connections by
 * adopting the workspace's GitHub App installation; repositories; the pull
 * request mirror with issue links; the derived inbox; provider accounts.
 *
 * The enums mirror `packages/core/db/src/schema/weldmerge.ts`; keep them in
 * step. Design: design/modules/weldmerge.md (weldsuite-documentation).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MERGE_ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'] as const;
export type MergeIssueStatus = (typeof MERGE_ISSUE_STATUSES)[number];

/** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const MERGE_ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type MergeIssuePriority = (typeof MERGE_ISSUE_PRIORITIES)[number];

export const MERGE_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'azure_devops'] as const;
export type MergeProvider = (typeof MERGE_PROVIDERS)[number];

export const MERGE_CONNECTION_STATUSES = ['active', 'suspended', 'revoked', 'needs_attention'] as const;
export type MergeConnectionStatus = (typeof MERGE_CONNECTION_STATUSES)[number];

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

/** Pull request list views. */
export const MERGE_PULL_REQUEST_VIEWS = ['needs_review', 'mine', 'open', 'merged', 'closed'] as const;
export type MergePullRequestView = (typeof MERGE_PULL_REQUEST_VIEWS)[number];

export const MERGE_INBOX_KINDS = [
  'review_requested',
  'checks_failed',
  'changes_requested',
  'assigned',
  'merged',
] as const;
export type MergeInboxKind = (typeof MERGE_INBOX_KINDS)[number];

// ---------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------

/** Team key: 2–10 upper-case letters and digits, starting with a letter (`PLAT`, `API`, `M2`). */
export const mergeTeamKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Use 2–10 letters and digits, starting with a letter');

/** An issue key such as `PLAT-209`. */
export const MERGE_ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,9}$/;

const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #6e56cf');

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const nonEmptyPatch = { message: 'Nothing to update' } as const;

// ---------------------------------------------------------------------------
// Inputs: teams, labels, cycles
// ---------------------------------------------------------------------------

export const createMergeTeamSchema = z.object({
  key: mergeTeamKeySchema,
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullish(),
  color: colorSchema.nullish(),
});
export type CreateMergeTeamInput = z.input<typeof createMergeTeamSchema>;

/** The key can change only while the team has no issues (409 `conflict` otherwise). */
export const updateMergeTeamSchema = createMergeTeamSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, nonEmptyPatch);
export type UpdateMergeTeamInput = z.input<typeof updateMergeTeamSchema>;

export const createMergeLabelSchema = z.object({
  /** Null or left out: a workspace-wide label. */
  teamId: z.string().nullish(),
  name: z.string().trim().min(1).max(100),
  color: colorSchema.nullish(),
});
export type CreateMergeLabelInput = z.input<typeof createMergeLabelSchema>;

export const updateMergeLabelSchema = z
  .object({ name: z.string().trim().min(1).max(100), color: colorSchema.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nonEmptyPatch);
export type UpdateMergeLabelInput = z.input<typeof updateMergeLabelSchema>;

export const createMergeCycleSchema = z
  .object({
    teamId: z.string().min(1),
    name: z.string().trim().max(255).nullish(),
    startsAt: dateOnlySchema,
    endsAt: dateOnlySchema,
  })
  .refine((v) => v.endsAt >= v.startsAt, { message: 'The cycle must end on or after its start', path: ['endsAt'] });
export type CreateMergeCycleInput = z.input<typeof createMergeCycleSchema>;

export const updateMergeCycleSchema = z
  .object({ name: z.string().trim().max(255).nullable(), startsAt: dateOnlySchema, endsAt: dateOnlySchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nonEmptyPatch);
export type UpdateMergeCycleInput = z.input<typeof updateMergeCycleSchema>;

export const listMergeCyclesQuerySchema = z.object({ teamId: z.string().optional() });

// ---------------------------------------------------------------------------
// Inputs: issues and comments
// ---------------------------------------------------------------------------

export const createMergeIssueSchema = z.object({
  teamId: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).nullish(),
  status: z.enum(MERGE_ISSUE_STATUSES).default('backlog'),
  priority: prioritySchema.default(0),
  assigneeUserId: z.string().nullish(),
  cycleId: z.string().nullish(),
  parentIssueId: z.string().nullish(),
  labelIds: z.array(z.string()).max(20).default([]),
  estimate: z.number().int().min(0).max(1000).nullish(),
  dueDate: dateOnlySchema.nullish(),
  flowProjectId: z.string().nullish(),
});
export type CreateMergeIssueInput = z.input<typeof createMergeIssueSchema>;

/**
 * Moving to another team is not allowed (the key would change); everything
 * else is. `sortOrder` places the issue in its board column.
 */
export const updateMergeIssueSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable(),
    status: z.enum(MERGE_ISSUE_STATUSES),
    priority: prioritySchema,
    assigneeUserId: z.string().nullable(),
    cycleId: z.string().nullable(),
    parentIssueId: z.string().nullable(),
    labelIds: z.array(z.string()).max(20),
    estimate: z.number().int().min(0).max(1000).nullable(),
    dueDate: dateOnlySchema.nullable(),
    flowProjectId: z.string().nullable(),
    sortOrder: z.number().finite(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nonEmptyPatch);
export type UpdateMergeIssueInput = z.input<typeof updateMergeIssueSchema>;

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(item).optional());

export const listMergeIssuesQuerySchema = z.object({
  teamId: z.string().optional(),
  /** Comma-separated statuses. */
  status: csv(z.enum(MERGE_ISSUE_STATUSES)),
  /** A Clerk user id, or `me`, or `none` for unassigned. */
  assignee: z.string().optional(),
  cycleId: z.string().optional(),
  labelId: z.string().optional(),
  parentIssueId: z.string().optional(),
  /** Matches the title, or an exact key (`PLAT-209`). */
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListMergeIssuesQuery = z.input<typeof listMergeIssuesQuerySchema>;

export const createMergeCommentSchema = z.object({ body: z.string().trim().min(1).max(50_000) });
export type CreateMergeCommentInput = z.input<typeof createMergeCommentSchema>;

export const updateMergeCommentSchema = createMergeCommentSchema;
export type UpdateMergeCommentInput = z.input<typeof updateMergeCommentSchema>;

export const linkMergePullRequestSchema = z.object({
  pullRequestId: z.string().min(1),
  closes: z.boolean().default(true),
});
export type LinkMergePullRequestInput = z.input<typeof linkMergePullRequestSchema>;

// ---------------------------------------------------------------------------
// Inputs: connections, repositories, accounts, pull requests
// ---------------------------------------------------------------------------

export const addMergeRepositorySchema = z.object({
  connectionId: z.string().min(1),
  /** The provider's repository id, from `available-repositories`. */
  externalId: z.string().min(1),
  teamId: z.string().nullish(),
  prSync: z.boolean().default(true),
});
export type AddMergeRepositoryInput = z.input<typeof addMergeRepositorySchema>;

export const updateMergeRepositorySchema = z
  .object({
    teamId: z.string().nullable(),
    prSync: z.boolean(),
    /** Only `off` is accepted in phase 1. */
    issueSync: z.enum(MERGE_ISSUE_SYNC_MODES),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nonEmptyPatch);
export type UpdateMergeRepositoryInput = z.input<typeof updateMergeRepositorySchema>;

export const listMergePullRequestsQuerySchema = z.object({
  view: z.enum(MERGE_PULL_REQUEST_VIEWS).default('open'),
  repositoryId: z.string().optional(),
  teamId: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListMergePullRequestsQuery = z.input<typeof listMergePullRequestsQuerySchema>;

/** The member's own logins; an empty or null login removes it. */
export const updateMyMergeAccountsSchema = z.object({
  github: z
    .string()
    .trim()
    .max(39)
    .regex(/^$|^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Not a valid GitHub username')
    .nullish(),
});
export type UpdateMyMergeAccountsInput = z.input<typeof updateMyMergeAccountsSchema>;

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const mergeTeamDtoSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  /** Issues not done or canceled. */
  openIssueCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeTeamDto = z.infer<typeof mergeTeamDtoSchema>;

export const mergeLabelDtoSchema = z.object({
  id: z.string(),
  teamId: z.string().nullable(),
  name: z.string(),
  color: z.string().nullable(),
});
export type MergeLabelDto = z.infer<typeof mergeLabelDtoSchema>;

export const mergeCycleDtoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  number: z.number(),
  name: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  /** Issues in the cycle, and how many are done. */
  issueCount: z.number(),
  completedIssueCount: z.number(),
});
export type MergeCycleDto = z.infer<typeof mergeCycleDtoSchema>;

/** A pull request as it shows on an issue or in a list row. */
export const mergePullRequestSummarySchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  repositoryFullName: z.string(),
  provider: z.enum(MERGE_PROVIDERS),
  number: z.number(),
  title: z.string(),
  state: z.enum(MERGE_PULL_REQUEST_STATES),
  draft: z.boolean(),
  url: z.string(),
  authorLogin: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  authorUserId: z.string().nullable(),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  changedFiles: z.number().nullable(),
  checksStatus: z.enum(MERGE_CHECKS_STATUSES).nullable(),
  reviewDecision: z.enum(MERGE_REVIEW_DECISIONS).nullable(),
  requestedReviewers: z.array(
    z.object({
      kind: z.enum(['user', 'team']),
      login: z.string(),
      avatarUrl: z.string().nullable().optional(),
      userId: z.string().nullable().optional(),
    }),
  ),
  labels: z.array(z.object({ name: z.string(), color: z.string().nullable().optional() })),
  providerCreatedAt: z.string(),
  providerUpdatedAt: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});
export type MergePullRequestSummary = z.infer<typeof mergePullRequestSummarySchema>;

export const mergeIssueLinkSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.enum(MERGE_ISSUE_STATUSES),
  source: z.enum(MERGE_LINK_SOURCES),
  closes: z.boolean(),
});
export type MergeIssueLink = z.infer<typeof mergeIssueLinkSchema>;

export const mergeIssueDtoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamKey: z.string(),
  number: z.number(),
  /** `PLAT-209`. */
  key: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(MERGE_ISSUE_STATUSES),
  priority: prioritySchema,
  assigneeUserId: z.string().nullable(),
  creatorUserId: z.string(),
  cycleId: z.string().nullable(),
  parentIssueId: z.string().nullable(),
  labelIds: z.array(z.string()),
  estimate: z.number().nullable(),
  dueDate: z.string().nullable(),
  flowProjectId: z.string().nullable(),
  sortOrder: z.number(),
  /** Linked pull requests: their count in lists, the rows on `GET /issues/:idOrKey`. */
  pullRequestCount: z.number(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeIssueDto = z.infer<typeof mergeIssueDtoSchema>;

export const mergeIssueDetailDtoSchema = mergeIssueDtoSchema.extend({
  pullRequests: z.array(
    mergePullRequestSummarySchema.extend({ link: z.object({ source: z.enum(MERGE_LINK_SOURCES), closes: z.boolean() }) }),
  ),
  subIssues: z.array(mergeIssueDtoSchema),
});
export type MergeIssueDetailDto = z.infer<typeof mergeIssueDetailDtoSchema>;

export const mergeCommentDtoSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  authorUserId: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeCommentDto = z.infer<typeof mergeCommentDtoSchema>;

export const mergeConnectionDtoSchema = z.object({
  id: z.string(),
  provider: z.enum(MERGE_PROVIDERS),
  externalAccountId: z.string(),
  accountLogin: z.string().nullable(),
  accountType: z.string().nullable(),
  host: z.string().nullable(),
  status: z.enum(MERGE_CONNECTION_STATUSES),
  credentialsExpireAt: z.string().nullable(),
  repositoryCount: z.number(),
  createdAt: z.string(),
});
export type MergeConnectionDto = z.infer<typeof mergeConnectionDtoSchema>;

/**
 * `POST /connections/github`: the adopted connection, or `needs_install` when
 * the workspace has no active GitHub App installation yet. The platform then
 * starts connect-api's install flow (`/api/workflow-github/install-url`).
 */
export const connectMergeGithubResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('connected'), connection: mergeConnectionDtoSchema }),
  z.object({ status: z.literal('needs_install') }),
]);
export type ConnectMergeGithubResult = z.infer<typeof connectMergeGithubResultSchema>;

export const mergeAvailableRepositorySchema = z.object({
  externalId: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string().nullable(),
  url: z.string().nullable(),
  /** Already tracked by WeldMerge. */
  added: z.boolean(),
});
export type MergeAvailableRepository = z.infer<typeof mergeAvailableRepositorySchema>;

export const mergeRepositoryDtoSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  provider: z.enum(MERGE_PROVIDERS),
  externalId: z.string(),
  fullName: z.string(),
  defaultBranch: z.string().nullable(),
  private: z.boolean(),
  url: z.string().nullable(),
  teamId: z.string().nullable(),
  issueSync: z.enum(MERGE_ISSUE_SYNC_MODES),
  prSync: z.boolean(),
  openPullRequestCount: z.number(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MergeRepositoryDto = z.infer<typeof mergeRepositoryDtoSchema>;

/** `POST /repositories/:id/sync`. */
export const mergeRepositorySyncResultSchema = z.object({
  repository: mergeRepositoryDtoSchema,
  pullRequestsSynced: z.number(),
  linksCreated: z.number(),
});
export type MergeRepositorySyncResult = z.infer<typeof mergeRepositorySyncResultSchema>;

export const mergePullRequestDetailDtoSchema = mergePullRequestSummarySchema.extend({
  body: z.string().nullable(),
  headSha: z.string().nullable(),
  teamId: z.string().nullable(),
  issues: z.array(mergeIssueLinkSchema),
  syncedAt: z.string(),
});
export type MergePullRequestDetailDto = z.infer<typeof mergePullRequestDetailDtoSchema>;

/** A pull request list row, with the issues it is linked to. */
export const mergePullRequestListItemSchema = mergePullRequestSummarySchema.extend({
  teamId: z.string().nullable(),
  issues: z.array(mergeIssueLinkSchema),
});
export type MergePullRequestListItem = z.infer<typeof mergePullRequestListItemSchema>;

export const mergeInboxItemSchema = z.object({
  /** Stable per subject and kind, e.g. `review_requested:mpr_…`. */
  id: z.string(),
  kind: z.enum(MERGE_INBOX_KINDS),
  /** When the subject last changed: the sort key, newest first. */
  at: z.string(),
  pullRequest: mergePullRequestListItemSchema.nullable(),
  issue: mergeIssueDtoSchema.nullable(),
});
export type MergeInboxItem = z.infer<typeof mergeInboxItemSchema>;

export const mergeProviderAccountsDtoSchema = z.object({
  github: z.string().nullable(),
});
export type MergeProviderAccountsDto = z.infer<typeof mergeProviderAccountsDtoSchema>;

// ---------------------------------------------------------------------------
// Internal: forwarded GitHub webhook (integration-webhook-worker → MergeInternal)
// ---------------------------------------------------------------------------

export const MERGE_GITHUB_FORWARDED_EVENTS = [
  'pull_request',
  'pull_request_review',
  'check_suite',
  'installation_repositories',
] as const;
export type MergeGithubForwardedEvent = (typeof MERGE_GITHUB_FORWARDED_EVENTS)[number];

export const mergeGithubEventEnvelopeSchema = z.object({
  /**
   * The installation's workspace: `workspaces.id`, or the Clerk org id while
   * integration-webhook-worker still resolves installations by it. Looked up
   * with `matchWorkspaceRef` (SEC-011).
   */
  workspaceId: z.string().min(1),
  /** The `X-GitHub-Event` header. */
  event: z.enum(MERGE_GITHUB_FORWARDED_EVENTS),
  /** The `X-GitHub-Delivery` header, for logs. */
  deliveryId: z.string().nullish(),
  /** The verified webhook body. */
  payload: z.record(z.unknown()),
});
export type MergeGithubEventEnvelope = z.infer<typeof mergeGithubEventEnvelopeSchema>;

/** What `MergeInternal.githubEvent` answers: applied, or why the event was dropped. */
export const mergeGithubEventAckSchema = z.object({
  outcome: z.enum(['applied', 'ignored']),
  reason: z.string().optional(),
});
export type MergeGithubEventAck = z.infer<typeof mergeGithubEventAckSchema>;
