/**
 * POST /agent-tool: a WeldAgent WeldMerge tool call, forwarded by agent-api
 * (`MergeInternal.agentTool()`).
 *
 * The tools are `MERGE_AGENT_TOOLS`. Each is checked against the permissions of
 * the agent's acting member (`envelope.userId`: whoever the agent works for or
 * assigned it the issue) as they are now, on top of the agent's own grants that
 * agent-api already enforced when it registered the tool. The writes use the
 * same services and entity events as the member routes; the events carry
 * `triggeredByAgentId`, so an agent never wakes itself.
 *
 *   merge_list_issues / merge_get_issue                 merge_issues:read
 *   merge_create_issue                                  merge_issues:create
 *   merge_update_issue / merge_comment_on_issue         merge_issues:update
 *   merge_list_pull_requests / merge_get_pull_request   merge_pull_requests:read
 *   merge_open_draft_pull_request                       merge_pull_requests:review + merge_connections:read
 *
 * Answers `{ ok, result, error }`; a refusal is `ok: false`, not an error
 * status. Contract: schemas/weldmerge-across.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { success } from '@weldsuite/worker-kit/response';
import {
  createMergeIssueSchema,
  listMergeIssuesQuerySchema,
  listMergePullRequestsQuerySchema,
  updateMergeIssueSchema,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  mergeAgentToolEnvelopeSchema,
  mergeDraftPullRequestInputSchema,
  type MergeAgentTool,
  type MergeAgentToolResult,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { userPermissionCheck } from '@weldsuite/chat-domain/entity-channels';
import type { Env, Variables } from '../../types';
import type { Ctx } from '../shared';
import { authorizeMember, MemberForbiddenError, resolveInternalWorkspace } from '../../services/across-access';
import { commentOnIssueAs, createIssueAs, describeIssues, updateIssueAs, type Actor } from '../../services/across-issues';
import { listComments } from '../../services/comments';
import { findConnection } from '../../services/connections';
import { GithubApiError, GithubNotConfiguredError } from '../../services/github-client';
import { DraftPullRequestError, openDraftPullRequest } from '../../services/draft-pull-request';
import { getIssueDetail, hydrateIssues, listIssues } from '../../services/issues';
import { commentDto } from '../../services/mappers';
import { getPullRequestDetail, listPullRequests } from '../../services/pull-requests';
import { recordTitleAccess, withVisibleTitles } from '../../services/record-links';
import { findRepository } from '../../services/repositories';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type Needs = Array<{ key: string; doing: string }>;

const PERMISSIONS: Record<MergeAgentTool, Needs> = {
  merge_list_issues: [{ key: 'merge_issues:read', doing: 'read issues' }],
  merge_get_issue: [{ key: 'merge_issues:read', doing: 'read issues' }],
  merge_create_issue: [{ key: 'merge_issues:create', doing: 'create issues' }],
  merge_update_issue: [{ key: 'merge_issues:update', doing: 'change issues' }],
  merge_comment_on_issue: [{ key: 'merge_issues:update', doing: 'comment on issues' }],
  merge_list_pull_requests: [{ key: 'merge_pull_requests:read', doing: 'read pull requests' }],
  merge_get_pull_request: [{ key: 'merge_pull_requests:read', doing: 'read pull requests' }],
  merge_open_draft_pull_request: [
    { key: 'merge_pull_requests:review', doing: 'open pull requests' },
    { key: 'merge_connections:read', doing: 'use connected repositories' },
  ],
};

const refSchema = z.object({ issue: z.string().min(1) });
const listIssuesInput = listMergeIssuesQuerySchema.omit({ status: true }).extend({
  /** One status, a comma-separated list or an array. */
  status: z.union([z.string(), z.array(z.string())]).optional(),
});
const idInput = z.object({ pullRequestId: z.string().min(1) });
const commentInput = refSchema.extend({ body: z.string().trim().min(1).max(50_000) });
const updateInput = refSchema.and(updateMergeIssueSchema);

const ok = (result: unknown): MergeAgentToolResult => ({ ok: true, result, error: null });
const refuse = (error: string): MergeAgentToolResult => ({ ok: false, result: null, error });

function invalid(error: z.ZodError): MergeAgentToolResult {
  return refuse(describeIssues(error.issues));
}

interface ToolRun {
  c: Ctx;
  actor: Actor;
  input: Record<string, unknown>;
}

type ToolHandler = (run: ToolRun) => Promise<MergeAgentToolResult>;

/** Parses the tool's input, then runs `work` with it; bad input is a refusal the agent can read. */
function tool<S extends z.ZodTypeAny>(schema: S, work: (data: z.output<S>, run: ToolRun) => Promise<MergeAgentToolResult>): ToolHandler {
  return async (run) => {
    const parsed = schema.safeParse(run.input);
    return parsed.success ? work(parsed.data, run) : invalid(parsed.error);
  };
}

const listIssuesTool = tool(listIssuesInput, async (data, { c, actor }) => {
  const status = Array.isArray(data.status) ? data.status.join(',') : data.status;
  const query = listMergeIssuesQuerySchema.safeParse({ ...data, status });
  if (!query.success) return invalid(query.error);
  const db = c.get('tenantDb');
  const page = await listIssues(db, query.data, actor.userId);
  return ok({ issues: await hydrateIssues(db, page.rows), hasMore: page.hasMore, cursor: page.cursor });
});

const getIssue = tool(refSchema, async (data, { c, actor }) => {
  const db = c.get('tenantDb');
  const detail = await getIssueDetail(db, data.issue);
  if (!detail) return refuse(`Issue ${data.issue} was not found`);
  // A linked record's title only where the acting member may read the record.
  const access = recordTitleAccess(db, actor.userId, userPermissionCheck(db, actor.userId));
  const recordLinks = await withVisibleTitles(access, detail.recordLinks);
  return ok({ ...detail, recordLinks, comments: (await listComments(db, detail.id)).map(commentDto) });
});

const createIssue = tool(createMergeIssueSchema, async (data, { c, actor }) => {
  const outcome = await createIssueAs(c, actor, data);
  return outcome.ok ? ok(outcome.issue) : refuse(outcome.message);
});

const updateIssue = tool(updateInput, async (data, { c, actor }) => {
  const { issue, ...patch } = data;
  const outcome = await updateIssueAs(c, actor, issue, patch);
  return outcome.ok ? ok(outcome.issue) : refuse(outcome.message);
});

const commentOnIssue = tool(commentInput, async (data, { c, actor }) => {
  const outcome = await commentOnIssueAs(c, actor, data.issue, data.body);
  return outcome.ok ? ok(outcome.comment) : refuse(outcome.message);
});

const listPullRequestsTool = tool(listMergePullRequestsQuerySchema, async (data, { c, actor }) => {
  const page = await listPullRequests(c.get('tenantDb'), data, actor.userId);
  return ok({ pullRequests: page.items, hasMore: page.hasMore, cursor: page.cursor });
});

const getPullRequest = tool(idInput, async (data, { c }) => {
  const detail = await getPullRequestDetail(c.get('tenantDb'), data.pullRequestId);
  return detail ? ok(detail) : refuse(`Pull request ${data.pullRequestId} was not found`);
});

/** GitHub's refusals as something the agent can read; anything else is not ours to answer. */
function githubRefusal(err: unknown): MergeAgentToolResult | null {
  if (err instanceof DraftPullRequestError) return refuse(err.message);
  if (err instanceof GithubNotConfiguredError) return refuse('GitHub is not configured for WeldMerge');
  if (err instanceof GithubApiError) return refuse('GitHub answered with an error');
  return null;
}

const openDraftPullRequestTool = tool(mergeDraftPullRequestInputSchema, async (data, { c }) => {
  const db = c.get('tenantDb');
  const repository = await findRepository(db, data.repositoryId);
  if (!repository) return refuse(`Repository ${data.repositoryId} was not found`);
  if (repository.provider !== 'github') return refuse('Opening a draft pull request is only supported for GitHub repositories');
  const connection = await findConnection(db, repository.connectionId);
  if (!connection) return refuse('The repository connection was not found');
  try {
    return ok(await openDraftPullRequest(c.env, connection.externalAccountId, repository, data));
  } catch (err) {
    const refusal = githubRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
});

const HANDLERS: Record<MergeAgentTool, ToolHandler> = {
  merge_list_issues: listIssuesTool,
  merge_get_issue: getIssue,
  merge_create_issue: createIssue,
  merge_update_issue: updateIssue,
  merge_comment_on_issue: commentOnIssue,
  merge_list_pull_requests: listPullRequestsTool,
  merge_get_pull_request: getPullRequest,
  merge_open_draft_pull_request: openDraftPullRequestTool,
};

app.post('/agent-tool', zValidator('json', mergeAgentToolEnvelopeSchema), async (c) => {
  const envelope = c.req.valid('json');
  const db = await resolveInternalWorkspace(c, envelope.workspaceId, envelope.userId);
  if (!db) return success(c, refuse(`Workspace ${envelope.workspaceId} was not found or is suspended`));

  try {
    for (const need of PERMISSIONS[envelope.tool]) {
      await authorizeMember(db, c.env, envelope.userId, need.key, need.doing);
    }
  } catch (err) {
    if (err instanceof MemberForbiddenError) return success(c, refuse(err.message));
    throw err;
  }
  const actor: Actor = { userId: envelope.userId, agentId: envelope.agentId ?? null };
  return success(c, await HANDLERS[envelope.tool]({ c, actor, input: envelope.input }));
});

export default app;
