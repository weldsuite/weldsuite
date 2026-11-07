/**
 * WeldAgent tools for WeldMerge: issues, pull requests and a draft pull request
 * an agent can open.
 *
 * The data lives in merge-api, so each tool calls its `MergeInternal`
 * entrypoint (`MERGE_INTERNAL.agentTool`). The call acts for the person the
 * agent works for (or who assigned it the issue): merge-api checks that
 * member's WeldMerge permissions as they are now, on top of the agent's own
 * grants, which decided whether the tool was registered at all. The writes
 * publish the same entity events the member routes do, marked
 * `triggeredByAgentId` so an agent never wakes itself.
 *
 * An issue assigned to an agent (`merge_issue.agent_assigned`) starts that
 * agent with the issue as its task (agent-api's entity-agents dispatch).
 */

import { z } from 'zod';
import { MERGE_ISSUE_STATUSES } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeAgentTool } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { PlatformToolDefinition, ToolContext } from './tools';

const issueRef = z.string().min(1).max(255).describe('The issue id, or its key such as PLAT-209');
const status = z.enum(MERGE_ISSUE_STATUSES);
const priority = z.number().int().min(0).max(4).describe('0 none, 1 urgent, 2 high, 3 medium, 4 low');

const listIssuesParams = z.object({
  teamId: z.string().max(255).optional(),
  status: z.array(status).max(6).optional().describe('Only issues in these statuses'),
  assignee: z.string().max(255).optional().describe('A user id, "me" or "none" for unassigned'),
  q: z.string().max(200).optional().describe('Part of the title, or a key such as PLAT-209'),
  limit: z.number().int().min(1).max(100).optional(),
});

const getIssueParams = z.object({ issue: issueRef });

const createIssueParams = z.object({
  teamId: z.string().min(1).max(255).describe('The WeldMerge team the issue belongs to'),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).optional(),
  status: status.optional().describe('Default backlog'),
  priority: priority.optional(),
  assigneeUserId: z.string().max(255).optional(),
  labelIds: z.array(z.string()).max(20).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD'),
});

const updateIssueParams = z.object({
  issue: issueRef,
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(100_000).nullable().optional(),
  status: status.optional(),
  priority: priority.optional(),
  assigneeUserId: z.string().max(255).nullable().optional(),
  agentId: z
    .string()
    .max(30)
    .nullable()
    .optional()
    .describe('Assign the issue to a WeldAgent agent (it starts working on it); null unassigns'),
});

const commentParams = z.object({ issue: issueRef, body: z.string().trim().min(1).max(50_000) });

const listPullRequestsParams = z.object({
  view: z.enum(['needs_review', 'mine', 'open', 'merged', 'closed']).optional().describe('Default open'),
  repositoryId: z.string().max(255).optional(),
  teamId: z.string().max(255).optional(),
  q: z.string().max(200).optional().describe('Part of the title or branch, or the number such as #123'),
  limit: z.number().int().min(1).max(100).optional(),
});

const getPullRequestParams = z.object({ pullRequestId: z.string().min(1).max(255) });

const draftPullRequestParams = z.object({
  repositoryId: z.string().min(1).max(255).describe('A connected GitHub repository (see merge_list_pull_requests)'),
  title: z.string().trim().min(1).max(1000),
  body: z.string().max(65_000).optional(),
  branch: z.string().trim().min(1).max(250).describe('The new branch to commit to, e.g. agent/plat-209-fix-tabs'),
  baseBranch: z.string().trim().max(250).optional().describe('Default: the repository default branch'),
  commitMessage: z.string().trim().min(1).max(1000),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1000),
        content: z.string().max(1_000_000).describe('The whole new content of the file'),
      }),
    )
    .min(1)
    .max(50)
    .describe('Files to add or replace; each is committed in full'),
  issueKey: z.string().max(50).optional().describe('The WeldMerge issue this work is for (PLAT-209): linked to the pull request'),
});

const UNAVAILABLE = { error: 'WeldMerge is not available to agents here' };

/** The tool's result, or merge-api's refusal as an error the agent can read. */
async function call(ctx: ToolContext, tool: MergeAgentTool, input: Record<string, unknown>): Promise<unknown> {
  const binding = ctx.env?.MERGE_INTERNAL;
  if (!binding) return UNAVAILABLE;
  const answer = await binding.agentTool({
    workspaceId: ctx.workspaceId,
    userId: ctx.actorUserId,
    agentId: ctx.agentId,
    tool,
    input,
  });
  return answer.ok ? (answer.result ?? { ok: true }) : { error: answer.error ?? 'WeldMerge refused the request' };
}

export const MERGE_TOOLS: PlatformToolDefinition[] = [
  {
    id: 'merge.list_issues',
    name: 'merge_list_issues',
    description: 'List WeldMerge issues, newest first, optionally by team, status, assignee or text.',
    requiredPermissions: ['merge_issues:read'],
    parameters: listIssuesParams,
    execute: async (ctx, raw) => call(ctx, 'merge_list_issues', listIssuesParams.parse(raw)),
  },
  {
    id: 'merge.get_issue',
    name: 'merge_get_issue',
    description: 'Read one WeldMerge issue with its comments, linked pull requests, sub-issues and linked records.',
    requiredPermissions: ['merge_issues:read'],
    parameters: getIssueParams,
    execute: async (ctx, raw) => call(ctx, 'merge_get_issue', getIssueParams.parse(raw)),
  },
  {
    id: 'merge.create_issue',
    name: 'merge_create_issue',
    description: 'Create a WeldMerge issue in a team.',
    requiredPermissions: ['merge_issues:create'],
    parameters: createIssueParams,
    execute: async (ctx, raw) => call(ctx, 'merge_create_issue', createIssueParams.parse(raw)),
  },
  {
    id: 'merge.update_issue',
    name: 'merge_update_issue',
    description: 'Change a WeldMerge issue: title, description, status, priority, assignee, or hand it to an agent.',
    requiredPermissions: ['merge_issues:update'],
    parameters: updateIssueParams,
    execute: async (ctx, raw) => call(ctx, 'merge_update_issue', updateIssueParams.parse(raw)),
  },
  {
    id: 'merge.comment_on_issue',
    name: 'merge_comment_on_issue',
    description: 'Add a comment to a WeldMerge issue (it is posted as the person you work for).',
    requiredPermissions: ['merge_issues:update'],
    parameters: commentParams,
    execute: async (ctx, raw) => call(ctx, 'merge_comment_on_issue', commentParams.parse(raw)),
  },
  {
    id: 'merge.list_pull_requests',
    name: 'merge_list_pull_requests',
    description:
      'List WeldMerge pull requests (open by default) across the connected repositories, with the issues they are linked to.',
    requiredPermissions: ['merge_pull_requests:read'],
    parameters: listPullRequestsParams,
    execute: async (ctx, raw) => call(ctx, 'merge_list_pull_requests', listPullRequestsParams.parse(raw)),
  },
  {
    id: 'merge.get_pull_request',
    name: 'merge_get_pull_request',
    description: 'Read one pull request: description, branch, state and the issues linked to it.',
    requiredPermissions: ['merge_pull_requests:read'],
    parameters: getPullRequestParams,
    execute: async (ctx, raw) => call(ctx, 'merge_get_pull_request', getPullRequestParams.parse(raw)),
  },
  {
    id: 'merge.open_draft_pull_request',
    name: 'merge_open_draft_pull_request',
    description:
      'Commit the given files to a NEW branch of a connected GitHub repository and open a DRAFT pull request for them. ' +
      'Nothing is merged: a person reviews it and marks it ready. GitHub repositories only.',
    requiredPermissions: ['merge_pull_requests:review', 'merge_connections:read'],
    parameters: draftPullRequestParams,
    execute: async (ctx, raw) => call(ctx, 'merge_open_draft_pull_request', draftPullRequestParams.parse(raw)),
  },
];
