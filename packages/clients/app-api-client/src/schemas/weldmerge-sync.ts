/**
 * WeldMerge phase 2 contract: GitHub all the way. The GitHub App install flow
 * in merge-api, two-way issue sync, and per-member inbox state. Zod v3.
 *
 * Shared by merge-api, rust/modules/merge and the platform. Design:
 * docs/plans/weldmerge-phases-2-5.md.
 */

import { z } from 'zod';
import { mergeExternalIssueDtoSchema } from './weldmerge';

// ---------------------------------------------------------------------------
// GitHub App install flow
// ---------------------------------------------------------------------------

/** `GET /connections/github/install-url?returnTo=`. `returnTo` must be a same-app relative path (`/…`), else it is ignored. */
export const mergeGithubInstallUrlQuerySchema = z.object({
  returnTo: z.string().max(500).optional(),
});
export type MergeGithubInstallUrlQuery = z.input<typeof mergeGithubInstallUrlQuerySchema>;

export const mergeInstallUrlDtoSchema = z.object({ url: z.string() });
export type MergeInstallUrlDto = z.infer<typeof mergeInstallUrlDtoSchema>;

/** The claims of the signed install `state` (HS256 JWT, 600 s), as connect-api's `signInstallStateJwt`. */
export const mergeGithubInstallStateSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  returnTo: z.string().nullish(),
  nonce: z.string(),
});
export type MergeGithubInstallState = z.infer<typeof mergeGithubInstallStateSchema>;

/** Where the public setup route sends the member when `returnTo` is absent. */
export const MERGE_GITHUB_INSTALL_DEFAULT_RETURN = '/weldmerge/settings?tab=providers&installed=1';

/** Public `GET /public/merge/github/setup?installation_id&setup_action&state` (answers with a redirect). */
export const mergeGithubSetupQuerySchema = z.object({
  installation_id: z.string().regex(/^\d+$/),
  setup_action: z.string().optional(),
  state: z.string().min(1),
});
export type MergeGithubSetupQuery = z.input<typeof mergeGithubSetupQuerySchema>;

// ---------------------------------------------------------------------------
// Issue sync
// ---------------------------------------------------------------------------

/** `POST /repositories/:id/import-issues`: open provider issues, up to 500. */
export const MERGE_IMPORT_ISSUES_LIMIT = 500;

export const mergeImportIssuesResultSchema = z.object({
  imported: z.number(),
  updated: z.number(),
  skipped: z.number(),
});
export type MergeImportIssuesResult = z.infer<typeof mergeImportIssuesResultSchema>;

/** `POST /issues/:id/external`: create the issue on the repository's provider and link it. */
export const createMergeExternalIssueSchema = z.object({ repositoryId: z.string().min(1) });
export type CreateMergeExternalIssueInput = z.input<typeof createMergeExternalIssueSchema>;

/** The external issue as the sync routes answer it. */
export const mergeExternalIssueResultSchema = mergeExternalIssueDtoSchema;
export type MergeExternalIssueResult = z.infer<typeof mergeExternalIssueResultSchema>;

/** The synced fields behind `merge_external_issues.checksum` (sha-256 of their canonical JSON). */
export const mergeSyncedIssueFieldsSchema = z.object({
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  stateReason: z.enum(['completed', 'not_planned']).nullable(),
  labels: z.array(z.string()),
  assignee: z.string().nullable(),
});
export type MergeSyncedIssueFields = z.infer<typeof mergeSyncedIssueFieldsSchema>;

// ---------------------------------------------------------------------------
// Inbox state (per member)
// ---------------------------------------------------------------------------

export const MERGE_INBOX_INCLUDES = ['archived', 'snoozed'] as const;
export type MergeInboxInclude = (typeof MERGE_INBOX_INCLUDES)[number];

/** `GET /inbox?include=`: archived and still-snoozed items are left out unless asked for. */
export const listMergeInboxQuerySchema = z.object({
  include: z.enum(MERGE_INBOX_INCLUDES).optional(),
});
export type ListMergeInboxQuery = z.input<typeof listMergeInboxQuerySchema>;

/** `PATCH /inbox/items/:itemKey`. `read: false` marks unread; `snoozedUntil: null` wakes it; `archived: false` restores it. */
export const updateMergeInboxItemSchema = z
  .object({
    read: z.boolean(),
    snoozedUntil: z.string().datetime({ offset: true }).nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateMergeInboxItemInput = z.input<typeof updateMergeInboxItemSchema>;

export const mergeInboxItemStateDtoSchema = z.object({
  itemKey: z.string(),
  read: z.boolean(),
  snoozedUntil: z.string().nullable(),
  archived: z.boolean(),
});
export type MergeInboxItemStateDto = z.infer<typeof mergeInboxItemStateDtoSchema>;

/** `POST /inbox/read-all`. */
export const mergeInboxReadAllResultSchema = z.object({ updated: z.number() });
export type MergeInboxReadAllResult = z.infer<typeof mergeInboxReadAllResultSchema>;
