/**
 * WeldMerge phase 4 contract: review and merge in WeldMerge. Everything is
 * read live from the provider; nothing here is stored except what sync already
 * mirrors. Zod v3.
 *
 * Error codes on these routes: 409 `account_not_linked` (the member has no
 * verified account for the provider), 409 `not_mergeable`, 422
 * `unsupported_method`, 502 `provider_error` (the provider's own message).
 *
 * Design: docs/plans/weldmerge-phases-2-5.md.
 */

import { z } from 'zod';
import { mergePullRequestDetailDtoSchema } from './weldmerge';

export const MERGE_REVIEW_EVENTS = ['approve', 'request_changes', 'comment'] as const;
export type MergeReviewEvent = (typeof MERGE_REVIEW_EVENTS)[number];

export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export const MERGE_DIFF_SIDES = ['LEFT', 'RIGHT'] as const;
export type MergeDiffSide = (typeof MERGE_DIFF_SIDES)[number];

export const MERGE_FILE_STATUSES = ['added', 'removed', 'modified', 'renamed', 'copied', 'changed'] as const;
export type MergeFileStatus = (typeof MERGE_FILE_STATUSES)[number];

/** `GET /pull-requests/:id/files`. `patch` is null for binary or too-large files. */
export const mergePullRequestFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum(MERGE_FILE_STATUSES),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullable(),
});
export type MergePullRequestFile = z.infer<typeof mergePullRequestFileSchema>;

export const mergeThreadAuthorSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().nullable(),
});
export type MergeThreadAuthor = z.infer<typeof mergeThreadAuthorSchema>;

export const mergeThreadCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: mergeThreadAuthorSchema.nullable(),
  createdAt: z.string(),
  url: z.string().nullable(),
});
export type MergeThreadComment = z.infer<typeof mergeThreadCommentSchema>;

/** A review thread anchored to a line, or (path null) a general conversation comment. */
export const mergeReviewThreadSchema = z.object({
  id: z.string(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  side: z.enum(MERGE_DIFF_SIDES).nullable(),
  resolved: z.boolean(),
  comments: z.array(mergeThreadCommentSchema),
});
export type MergeReviewThread = z.infer<typeof mergeReviewThreadSchema>;

/** A line comment sent with a review or on its own. */
export const mergeLineCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  side: z.enum(MERGE_DIFF_SIDES).default('RIGHT'),
  body: z.string().trim().min(1).max(65_000),
});
export type MergeLineCommentInput = z.input<typeof mergeLineCommentSchema>;

/** `POST /pull-requests/:id/reviews`. `body` is required for `request_changes` and `comment` without line comments. */
export const submitMergeReviewSchema = z
  .object({
    event: z.enum(MERGE_REVIEW_EVENTS),
    body: z.string().trim().max(65_000).optional(),
    comments: z.array(mergeLineCommentSchema).max(100).optional(),
  })
  .refine((v) => v.event === 'approve' || Boolean(v.body) || (v.comments?.length ?? 0) > 0, {
    message: 'Add a comment to this review',
    path: ['body'],
  });
export type SubmitMergeReviewInput = z.input<typeof submitMergeReviewSchema>;

/** `POST /pull-requests/:id/comments`: a general comment, a new line comment (`path` + `line`), or a reply (`inReplyToId`). */
export const createMergePullRequestCommentSchema = z.object({
  body: z.string().trim().min(1).max(65_000),
  path: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
  side: z.enum(MERGE_DIFF_SIDES).optional(),
  inReplyToId: z.string().optional(),
});
export type CreateMergePullRequestCommentInput = z.input<typeof createMergePullRequestCommentSchema>;

/** `POST /pull-requests/:id/merge`. `rebase` on Azure DevOps means "rebase and fast-forward". */
export const mergeMergePullRequestSchema = z.object({
  method: z.enum(MERGE_METHODS).default('merge'),
  commitTitle: z.string().trim().max(500).optional(),
  commitMessage: z.string().max(10_000).optional(),
});
export type MergeMergePullRequestInput = z.input<typeof mergeMergePullRequestSchema>;

/** Review and merge answer with the refreshed mirror. */
export const mergeReviewResultSchema = z.object({
  pullRequest: mergePullRequestDetailDtoSchema,
});
export type MergeReviewResult = z.infer<typeof mergeReviewResultSchema>;

/** A comment posted through `POST /pull-requests/:id/comments`. */
export const mergePullRequestCommentResultSchema = z.object({
  comment: mergeThreadCommentSchema,
  threadId: z.string().nullable(),
});
export type MergePullRequestCommentResult = z.infer<typeof mergePullRequestCommentResultSchema>;
