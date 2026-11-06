/**
 * Issue routes: /api/merge/issues/*.
 *
 *   GET    /                          -> list (teamId, status csv, assignee me|none|<user>, cycleId, labelId, parentIssueId, q; cursor)
 *   GET    /:idOrKey                  -> detail by id or key (PLAT-209), with linked pull requests and sub-issues
 *   POST   /                          -> new issue; the team's next number is allocated with the insert
 *   PATCH  /:id                       -> edit (never the team); status changes keep started/completed timestamps;
 *                                        a new `agentId` must be an active agent the caller could use
 *                                        (`weldagent:use` + its visibility), else 422 `invalid_agent`
 *   DELETE /:id                       -> soft delete
 *   GET    /:id/comments              -> comments                       (merge_issues:read)
 *   POST   /:id/comments              -> comment                        (merge_issues:update)
 *   POST   /:id/pull-requests         -> link a pull request by hand     (merge_issues:update)
 *   DELETE /:id/pull-requests/:prId   -> remove a link                   (merge_issues:update)
 *
 * Permissions: merge_issues:read | create | update | delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createMergeCommentSchema,
  createMergeIssueSchema,
  linkMergePullRequestSchema,
  listMergeIssuesQuerySchema,
  updateMergeIssueSchema,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import { hookContext, titleAccess, type Ctx } from '../shared';
import { diffFields, publishEntityEvents, type PendingEvent } from '../../services/events';
import { commentDto, issueEventData, recordLinkEventData } from '../../services/mappers';
import type { MergeIssueRow } from '../../services/db';
import { createComment, listComments } from '../../services/comments';
import {
  createIssue,
  deleteIssue,
  findIssue,
  getIssueDetail,
  hydrateIssues,
  ISSUE_CHANGE_FIELDS,
  listIssues,
  updateIssue,
  type AgentAssigner,
  type IssueRefFailure,
} from '../../services/issues';
import { afterCommentChanged, afterIssueCreated, afterIssueUpdated } from '../../services/hooks';
import { linkPullRequest, unlinkPullRequest } from '../../services/pull-requests';
import { getTeam } from '../../services/teams';
import { withVisibleTitles } from '../../services/record-links';
import type { MergeIssueDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function issueEvent(
  issue: MergeIssueRow,
  teamKey: string,
  action: 'created' | 'updated' | 'deleted' | 'agent_assigned',
  changes?: PendingEvent['changes'],
): PendingEvent {
  return { entityType: 'merge_issue', action, entityId: issue.id, data: issueEventData(issue, teamKey), changes };
}

function publishIssueEvent(c: Ctx, event: PendingEvent) {
  publishEntityEvents(c, [event]);
}

function refFailure(c: Ctx, reason: IssueRefFailure) {
  switch (reason) {
    case 'cycle_invalid':
      return error.badRequest(c, "The cycle does not exist or belongs to another team");
    case 'parent_invalid':
      return error.badRequest(c, 'The parent issue must be another issue of the same team, and not one of its own sub-issues');
    case 'labels_invalid':
      return error.badRequest(c, 'A label does not exist or belongs to another team');
  }
}

async function oneDto(c: Ctx, issue: MergeIssueRow) {
  const [dto] = await hydrateIssues(c.get('tenantDb'), [issue]);
  return dto!;
}

/** The detail with the linked records' titles the caller may not read left out (`withVisibleTitles`). */
async function visibleDetail(c: Ctx, detail: MergeIssueDetailDto): Promise<MergeIssueDetailDto> {
  return { ...detail, recordLinks: await withVisibleTitles(titleAccess(c), detail.recordLinks) };
}

app.get('/', requirePermission('merge_issues:read'), zValidator('query', listMergeIssuesQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const page = await listIssues(c.get('tenantDb'), query, c.get('userId'));
  const dtos = await hydrateIssues(c.get('tenantDb'), page.rows);
  return list(c, dtos, cursorPagination(dtos.length, page.hasMore, page.cursor));
});

app.get('/:id', requirePermission('merge_issues:read'), async (c) => {
  const id = c.req.param('id');
  const detail = await getIssueDetail(c.get('tenantDb'), id);
  if (!detail) return error.notFound(c, 'Issue', id);
  return success(c, await visibleDetail(c, detail));
});

app.post('/', requirePermission('merge_issues:create'), zValidator('json', createMergeIssueSchema), async (c) => {
  const result = await createIssue(c.get('tenantDb'), c.req.valid('json'), c.get('userId'));
  if (!result.ok) {
    if (result.reason === 'team_not_found') return error.notFound(c, 'Team');
    return refFailure(c, result.reason);
  }
  publishEntityEvents(c, [
    issueEvent(result.issue, result.team.key, 'created'),
    ...result.links.map((link) => ({
      entityType: 'merge_record_link' as const,
      action: 'created' as const,
      entityId: link.id,
      data: recordLinkEventData(link),
    })),
  ]);
  await afterIssueCreated(hookContext(c), result.issue, result.team.key);
  return success(c, await oneDto(c, result.issue), 201);
});

/** The caller as an agent assigner: `weldagent:use`, and `weldagent:manage` for every agent. */
async function agentAssigner(c: Ctx): Promise<AgentAssigner> {
  return {
    userId: c.get('userId'),
    canUse: await hasContextPermission(c, 'weldagent:use'),
    canManageAll: await hasContextPermission(c, 'weldagent:manage'),
  };
}

app.patch('/:id', requirePermission('merge_issues:update'), zValidator('json', updateMergeIssueSchema), async (c) => {
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const result = await updateIssue(c.get('tenantDb'), id, input, input.agentId ? await agentAssigner(c) : undefined);
  if (!result.ok) {
    if (result.reason === 'not_found') return error.notFound(c, 'Issue', id);
    // Assigning runs the agent with the issue as its task: only an agent the caller could use themselves.
    if (result.reason === 'agent_invalid') {
      return c.json({ error: { code: 'invalid_agent', message: 'The agent does not exist, is not active, or you cannot use it' } }, 422);
    }
    return refFailure(c, result.reason);
  }
  const changes = diffFields(
    result.before as unknown as Record<string, unknown>,
    result.issue as unknown as Record<string, unknown>,
    ISSUE_CHANGE_FIELDS,
  );
  const events = [issueEvent(result.issue, result.teamKey, 'updated', changes)];
  // Assigning an agent also publishes `agent_assigned`: agent-api runs that agent with the issue as its task.
  if (result.issue.agentId && result.issue.agentId !== result.before.agentId) {
    events.push(issueEvent(result.issue, result.teamKey, 'agent_assigned', changes));
  }
  publishEntityEvents(c, events);
  await afterIssueUpdated(hookContext(c), result.before, result.issue, result.teamKey);
  return success(c, await oneDto(c, result.issue));
});

app.delete('/:id', requirePermission('merge_issues:delete'), async (c) => {
  const id = c.req.param('id');
  const result = await deleteIssue(c.get('tenantDb'), id);
  if (!result) return error.notFound(c, 'Issue', id);
  publishIssueEvent(c, issueEvent(result.issue, result.teamKey, 'deleted'));
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

app.get('/:id/comments', requirePermission('merge_issues:read'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  if (!(await findIssue(db, id))) return error.notFound(c, 'Issue', id);
  const comments = await listComments(db, id);
  return list(c, comments.map(commentDto), cursorPagination(comments.length, false, null));
});

app.post('/:id/comments', requirePermission('merge_issues:update'), zValidator('json', createMergeCommentSchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  if (!(await findIssue(db, id))) return error.notFound(c, 'Issue', id);
  const issue = (await findIssue(db, id))!;
  const comment = await createComment(db, id, c.get('userId'), c.req.valid('json').body);
  publishEntityEvents(c, [
    {
      entityType: 'merge_comment',
      action: 'created',
      entityId: comment.id,
      data: { id: comment.id, issueId: comment.issueId, authorUserId: comment.authorUserId },
    },
  ]);
  const team = await getTeam(db, issue.teamId);
  await afterCommentChanged(hookContext(c), 'created', comment, issue, team?.row.key ?? '');
  return success(c, commentDto(comment), 201);
});

// ---------------------------------------------------------------------------
// Pull request links
// ---------------------------------------------------------------------------

app.post('/:id/pull-requests', requirePermission('merge_issues:update'), zValidator('json', linkMergePullRequestSchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const issue = await findIssue(db, id);
  if (!issue) return error.notFound(c, 'Issue', id);
  const team = await getTeam(db, issue.teamId);
  const input = c.req.valid('json');
  const result = await linkPullRequest(db, issue, team?.row.key ?? '', input.pullRequestId, input.closes ?? true, c.get('userId'));
  if (!result.ok) return error.notFound(c, 'Pull request', input.pullRequestId);
  publishEntityEvents(c, result.events);
  return success(c, await visibleDetail(c, (await getIssueDetail(db, id))!));
});

app.delete('/:id/pull-requests/:prId', requirePermission('merge_issues:update'), async (c) => {
  const id = c.req.param('id');
  const prId = c.req.param('prId');
  const db = c.get('tenantDb');
  const issue = await findIssue(db, id);
  if (!issue) return error.notFound(c, 'Issue', id);
  if (!(await unlinkPullRequest(db, id, prId))) return error.notFound(c, 'Pull request link', prId);
  const team = await getTeam(db, issue.teamId);
  publishIssueEvent(c, issueEvent(issue, team?.row.key ?? '', 'updated'));
  return noContent(c);
});

export default app;
