/**
 * WeldMerge phase 5 contract: across WeldSuite. Releases, record links, chat
 * subscriptions, and the envelopes WeldConnect and WeldAgent use to call
 * merge-api. Zod v3.
 *
 * Design: weldsuite-documentation/plans/weldmerge-phases-2-5.md.
 */

import { z } from 'zod';
import {
  MERGE_ISSUE_STATUSES,
  MERGE_RECORD_TYPES,
  createMergeCommentSchema,
  createMergeIssueSchema,
  mergeIssueDtoSchema,
  mergePullRequestSummarySchema,
  mergeRecordLinkDtoSchema,
  updateMergeIssueSchema,
} from './weldmerge';

const nonEmptyPatch = { message: 'Nothing to update' } as const;

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export const MERGE_RELEASE_STATUSES = ['draft', 'shipped'] as const;
export type MergeReleaseStatus = (typeof MERGE_RELEASE_STATUSES)[number];

export const createMergeReleaseSchema = z.object({
  teamId: z.string().min(1),
  repositoryId: z.string().min(1),
  name: z.string().trim().min(1).max(255),
  version: z.string().trim().max(100).nullish(),
  baseRef: z.string().trim().max(500).nullish(),
  headRef: z.string().trim().max(500).nullish(),
  notes: z.string().max(100_000).nullish(),
});
export type CreateMergeReleaseInput = z.input<typeof createMergeReleaseSchema>;

export const updateMergeReleaseSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    version: z.string().trim().max(100).nullable(),
    baseRef: z.string().trim().max(500).nullable(),
    headRef: z.string().trim().max(500).nullable(),
    notes: z.string().max(100_000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nonEmptyPatch);
export type UpdateMergeReleaseInput = z.input<typeof updateMergeReleaseSchema>;

export const listMergeReleasesQuerySchema = z.object({
  teamId: z.string().optional(),
  repositoryId: z.string().optional(),
  status: z.enum(MERGE_RELEASE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListMergeReleasesQuery = z.input<typeof listMergeReleasesQuerySchema>;

export const mergeReleaseDtoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  repositoryId: z.string(),
  repositoryFullName: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
  status: z.enum(MERGE_RELEASE_STATUSES),
  notes: z.string().nullable(),
  notesGeneratedAt: z.string().nullable(),
  knowledgePageId: z.string().nullable(),
  shippedAt: z.string().nullable(),
  pullRequestCount: z.number(),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeReleaseDto = z.infer<typeof mergeReleaseDtoSchema>;

/** A desk ticket linked to an issue that shipped in the release. */
export const mergeReleaseTicketSchema = z.object({
  ticketId: z.string(),
  title: z.string().nullable(),
  issueId: z.string(),
  issueKey: z.string(),
});
export type MergeReleaseTicket = z.infer<typeof mergeReleaseTicketSchema>;

export const mergeReleaseDetailDtoSchema = mergeReleaseDtoSchema.extend({
  pullRequests: z.array(mergePullRequestSummarySchema),
  issues: z.array(mergeIssueDtoSchema),
  tickets: z.array(mergeReleaseTicketSchema),
});
export type MergeReleaseDetailDto = z.infer<typeof mergeReleaseDetailDtoSchema>;

/** `POST /releases/:id/generate-notes`: AI-written notes from the release's pull requests and issues. */
export const mergeGenerateNotesResultSchema = z.object({
  release: mergeReleaseDtoSchema,
});
export type MergeGenerateNotesResult = z.infer<typeof mergeGenerateNotesResultSchema>;

/** `POST /releases/:id/publish`: a WeldKnow page and/or an email with the notes. */
export const publishMergeReleaseSchema = z
  .object({
    knowledgeSpaceId: z.string().optional(),
    email: z
      .object({
        mailAccountId: z.string().min(1),
        to: z.array(z.string().email()).min(1).max(100),
        subject: z.string().trim().max(500).optional(),
      })
      .optional(),
  })
  .refine((v) => Boolean(v.knowledgeSpaceId) || Boolean(v.email), { message: 'Choose where to publish' });
export type PublishMergeReleaseInput = z.input<typeof publishMergeReleaseSchema>;

export const mergePublishReleaseResultSchema = z.object({
  release: mergeReleaseDtoSchema,
  knowledgePageId: z.string().nullable(),
  emailSent: z.boolean(),
});
export type MergePublishReleaseResult = z.infer<typeof mergePublishReleaseResultSchema>;

/** The `merge_release.shipped` event data: what flows into WeldConnect and the desk template. */
export const mergeReleaseShippedEventDataSchema = z.object({
  releaseId: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  repositoryId: z.string(),
  pullRequestIds: z.array(z.string()),
  issueIds: z.array(z.string()),
  deskTicketIds: z.array(z.string()),
});
export type MergeReleaseShippedEventData = z.infer<typeof mergeReleaseShippedEventDataSchema>;

// ---------------------------------------------------------------------------
// Record links
// ---------------------------------------------------------------------------

/** `GET /record-links?recordType=&recordId=`: what a ticket or company shows. */
export const listMergeRecordLinksQuerySchema = z.object({
  recordType: z.enum(MERGE_RECORD_TYPES),
  recordId: z.string().min(1),
});
export type ListMergeRecordLinksQuery = z.input<typeof listMergeRecordLinksQuerySchema>;

/** A linked issue as a ticket, company or chat channel shows it, with the release that shipped it. */
export const mergeRecordLinkedIssueSchema = z.object({
  link: mergeRecordLinkDtoSchema,
  issue: z.object({
    id: z.string(),
    key: z.string(),
    title: z.string(),
    status: z.enum(MERGE_ISSUE_STATUSES),
    teamId: z.string(),
    teamKey: z.string(),
  }),
  release: z
    .object({
      id: z.string(),
      name: z.string(),
      version: z.string().nullable(),
      shippedAt: z.string().nullable(),
    })
    .nullable(),
});
export type MergeRecordLinkedIssue = z.infer<typeof mergeRecordLinkedIssueSchema>;

// ---------------------------------------------------------------------------
// Chat subscriptions
// ---------------------------------------------------------------------------

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

export const createMergeChatSubscriptionSchema = z.object({
  channelId: z.string().min(1),
  teamId: z.string().nullish(),
  repositoryId: z.string().nullish(),
  events: z.array(z.enum(MERGE_CHAT_EVENTS)).min(1),
  /** UTC hour the daily digest is posted. */
  digestHour: z.number().int().min(0).max(23).default(9),
});
export type CreateMergeChatSubscriptionInput = z.input<typeof createMergeChatSubscriptionSchema>;

export const updateMergeChatSubscriptionSchema = z
  .object({
    teamId: z.string().nullable(),
    repositoryId: z.string().nullable(),
    events: z.array(z.enum(MERGE_CHAT_EVENTS)).min(1),
    digestHour: z.number().int().min(0).max(23),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nonEmptyPatch);
export type UpdateMergeChatSubscriptionInput = z.input<typeof updateMergeChatSubscriptionSchema>;

export const listMergeChatSubscriptionsQuerySchema = z.object({
  channelId: z.string().optional(),
  teamId: z.string().optional(),
});
export type ListMergeChatSubscriptionsQuery = z.input<typeof listMergeChatSubscriptionsQuerySchema>;

export const mergeChatSubscriptionDtoSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  teamId: z.string().nullable(),
  repositoryId: z.string().nullable(),
  events: z.array(z.enum(MERGE_CHAT_EVENTS)),
  digestHour: z.number(),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeChatSubscriptionDto = z.infer<typeof mergeChatSubscriptionDtoSchema>;

/** What the chat UI renders a card from: `metadata.weldmerge` on a system chat message posted as `app:weldmerge`. */
export const MERGE_CHAT_CARD_KINDS = [
  'review_requested',
  'checks_failed',
  'pull_request_merged',
  'issue_created',
  'issue_done',
  'release_shipped',
  'daily_digest',
  'shared_issue',
  'shared_pull_request',
] as const;
export type MergeChatCardKind = (typeof MERGE_CHAT_CARD_KINDS)[number];

export const mergeChatCardMetadataSchema = z.object({
  kind: z.enum(MERGE_CHAT_CARD_KINDS),
  pullRequestId: z.string().optional(),
  issueId: z.string().optional(),
  releaseId: z.string().optional(),
  /** The inbox item the card's *Snooze* acts on. */
  itemKey: z.string().optional(),
});
export type MergeChatCardMetadata = z.infer<typeof mergeChatCardMetadataSchema>;

/** The author id of every WeldMerge chat post. */
export const MERGE_CHAT_AUTHOR = 'app:weldmerge';

// ---------------------------------------------------------------------------
// Internal: WeldConnect actions and WeldAgent tools (service-binding envelopes)
// ---------------------------------------------------------------------------

export const MERGE_WORKFLOW_ACTIONS = ['merge.create_issue', 'merge.update_issue', 'merge.comment_on_issue'] as const;
export type MergeWorkflowAction = (typeof MERGE_WORKFLOW_ACTIONS)[number];

/** Per action: the inputs a workflow node resolves. `issue` is an id or a key (`PLAT-209`). */
export const mergeWorkflowActionInputSchemas = {
  'merge.create_issue': createMergeIssueSchema,
  'merge.update_issue': z.object({ issue: z.string().min(1) }).and(updateMergeIssueSchema),
  'merge.comment_on_issue': z.object({ issue: z.string().min(1) }).and(createMergeCommentSchema),
} as const;

/**
 * `MergeInternal.workflowAction`. `userId` is the workflow owner: the action is
 * permission-checked as that member (CONN-004).
 */
export const mergeWorkflowActionEnvelopeSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  action: z.enum(MERGE_WORKFLOW_ACTIONS),
  input: z.record(z.unknown()),
  /** Chain depth of the WeldConnect run, so the entity events the action causes cannot retrigger workflows forever. */
  chainDepth: z.number().int().min(0).optional(),
});
export type MergeWorkflowActionEnvelope = z.infer<typeof mergeWorkflowActionEnvelopeSchema>;

export const mergeWorkflowActionResultSchema = z.object({
  ok: z.boolean(),
  /** The issue created, updated or commented on. */
  issueId: z.string().nullable(),
  issueKey: z.string().nullable(),
  commentId: z.string().nullable(),
  error: z.string().nullable(),
});
export type MergeWorkflowActionResult = z.infer<typeof mergeWorkflowActionResultSchema>;

export const MERGE_AGENT_TOOLS = [
  'merge_list_issues',
  'merge_get_issue',
  'merge_create_issue',
  'merge_update_issue',
  'merge_comment_on_issue',
  'merge_list_pull_requests',
  'merge_get_pull_request',
  'merge_open_draft_pull_request',
] as const;
export type MergeAgentTool = (typeof MERGE_AGENT_TOOLS)[number];

/** `merge_open_draft_pull_request`: commits `files` to a new branch (Git Data API) and opens a draft PR. GitHub only. */
export const mergeDraftPullRequestInputSchema = z.object({
  repositoryId: z.string().min(1),
  title: z.string().trim().min(1).max(1000),
  body: z.string().max(65_000).optional(),
  branch: z.string().trim().min(1).max(250),
  baseBranch: z.string().trim().max(250).optional(),
  commitMessage: z.string().trim().min(1).max(1000),
  files: z
    .array(z.object({ path: z.string().min(1).max(1000), content: z.string().max(1_000_000) }))
    .min(1)
    .max(50),
  issueKey: z.string().optional(),
});
export type MergeDraftPullRequestInput = z.input<typeof mergeDraftPullRequestInputSchema>;

/** `MergeInternal.agentTool`. `userId` is the agent's acting member, whose permissions apply. */
export const mergeAgentToolEnvelopeSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  agentId: z.string().nullish(),
  tool: z.enum(MERGE_AGENT_TOOLS),
  input: z.record(z.unknown()),
});
export type MergeAgentToolEnvelope = z.infer<typeof mergeAgentToolEnvelopeSchema>;

export const mergeAgentToolResultSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
});
export type MergeAgentToolResult = z.infer<typeof mergeAgentToolResultSchema>;


// ---------------------------------------------------------------------------
// The MergeInternal service binding, as its callers see it
// ---------------------------------------------------------------------------

/**
 * What merge-api's `MergeInternal` entrypoint exposes over RPC. Callers type
 * their `MERGE_INTERNAL` binding with the part they use: integration-webhook-
 * worker `githubEvent` / `providerEvent`, workflow-worker `workflowAction`,
 * agent-api `agentTool`.
 */
export interface MergeInternalBinding {
  githubEvent(envelope: import('./weldmerge').MergeGithubEventEnvelope): Promise<import('./weldmerge').MergeGithubEventAck>;
  providerEvent(
    envelope: import('./weldmerge-providers').MergeProviderEventEnvelope,
  ): Promise<import('./weldmerge-providers').MergeProviderEventAck>;
  workflowAction(envelope: MergeWorkflowActionEnvelope): Promise<MergeWorkflowActionResult>;
  agentTool(envelope: MergeAgentToolEnvelope): Promise<MergeAgentToolResult>;
}
