/**
 * Review and merge: /api/merge/pull-requests/:id/{files,threads,reviews,comments,merge}.
 *
 *   GET  /:id/files     -> changed files with their patch (connection token)
 *   GET  /:id/threads   -> review threads and general comments (connection token)
 *   POST /:id/reviews   -> approve | request_changes | comment, as the member
 *   POST /:id/comments  -> a general comment, a line comment or a reply, as the member
 *   POST /:id/merge     -> merge | squash | rebase, as the member
 *
 * Permissions: merge_pull_requests:read, :review, :merge. A member without a
 * linked, verified account for the provider gets 409 `account_not_linked`; the
 * provider's own refusal is 502 `provider_error` or 409 `not_mergeable`; a
 * method or capability the provider lacks is 422 `unsupported_method`.
 * Contract: schemas/weldmerge-review.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import {
  createMergePullRequestCommentSchema,
  mergeMergePullRequestSchema,
  submitMergeReviewSchema,
} from '@weldsuite/app-api-client/schemas/weldmerge-review';
import type { Env, Variables } from '../../types';
import { publishEntityEvents } from '../../services/events';
import {
  commentOnPullRequest,
  listPullRequestFiles,
  listPullRequestThreads,
  mergePullRequest,
  submitReview,
  type ReviewFailure,
  type ReviewResult,
} from '../../services/review';
import { githubFailure, hookContext, type Ctx } from '../shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const FAILURE_STATUS = {
  account_not_linked: [409, 'account_not_linked'],
  not_mergeable: [409, 'not_mergeable'],
  unsupported: [422, 'unsupported_method'],
  provider_error: [502, 'provider_error'],
} as const;

function failureResponse(c: Ctx, id: string, failure: ReviewFailure): Response {
  if (failure.code === 'not_found') return error.notFound(c, 'Pull request', id);
  const [status, code] = FAILURE_STATUS[failure.code];
  return c.json({ error: { code, message: failure.message } }, status);
}

/** The answer of a service call: its failure as a response, or its value after the events are published. */
function respond<T>(c: Ctx, id: string, result: ReviewResult<T>, status: 200 | 201 = 200): Response {
  if (!result.ok) return failureResponse(c, id, result.failure);
  publishEntityEvents(c, result.events);
  return success(c, result.value, status);
}

/** A live list: everything the adapter read (capped), in the list envelope. */
function respondList<T>(c: Ctx, id: string, result: ReviewResult<T[]>): Response {
  if (!result.ok) return failureResponse(c, id, result.failure);
  return list(c, result.value, cursorPagination(result.value.length, false, null));
}

/** Runs a service call, turning an unconfigured or failing GitHub App into its response. */
async function run<T>(c: Ctx, id: string, call: () => Promise<ReviewResult<T>>, status: 200 | 201 = 200): Promise<Response> {
  try {
    return respond(c, id, await call(), status);
  } catch (err) {
    const response = githubFailure(c, err);
    if (response) return response;
    throw err;
  }
}

app.get('/:id/files', requirePermission('merge_pull_requests:read'), async (c) => {
  const id = c.req.param('id');
  try {
    return respondList(c, id, await listPullRequestFiles(hookContext(c), id));
  } catch (err) {
    return githubFailure(c, err) ?? Promise.reject(err);
  }
});

app.get('/:id/threads', requirePermission('merge_pull_requests:read'), async (c) => {
  const id = c.req.param('id');
  try {
    return respondList(c, id, await listPullRequestThreads(hookContext(c), id));
  } catch (err) {
    return githubFailure(c, err) ?? Promise.reject(err);
  }
});

app.post('/:id/reviews', requirePermission('merge_pull_requests:review'), zValidator('json', submitMergeReviewSchema), (c) => {
  const id = c.req.param('id');
  return run(c, id, async () => {
    const result = await submitReview(hookContext(c), id, c.req.valid('json'));
    return result.ok ? { ...result, value: { pullRequest: result.value } } : result;
  });
});

app.post('/:id/comments', requirePermission('merge_pull_requests:review'), zValidator('json', createMergePullRequestCommentSchema), (c) => {
  const id = c.req.param('id');
  const input = c.req.valid('json');
  if (Boolean(input.path) !== Boolean(input.line) && !input.inReplyToId) {
    return error.badRequest(c, 'A line comment needs both path and line');
  }
  return run(c, id, () => commentOnPullRequest(hookContext(c), id, input), 201);
});

app.post('/:id/merge', requirePermission('merge_pull_requests:merge'), zValidator('json', mergeMergePullRequestSchema), (c) => {
  const id = c.req.param('id');
  return run(c, id, async () => {
    const result = await mergePullRequest(hookContext(c), id, c.req.valid('json'));
    return result.ok ? { ...result, value: { pullRequest: result.value } } : result;
  });
});

export default app;
