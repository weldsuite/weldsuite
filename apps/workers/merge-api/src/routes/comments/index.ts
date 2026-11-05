/**
 * Comment routes: /api/merge/comments/*. (Listing and creating live under an
 * issue: /api/merge/issues/:id/comments.)
 *
 *   PATCH  /:id -> edit; the author only                        (merge_issues:update)
 *   DELETE /:id -> the author's own with merge_issues:update; anyone's with merge_issues:delete
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { updateMergeCommentSchema } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import { hookContext, type Ctx } from '../shared';
import { publishEntityEvents } from '../../services/events';
import { commentDto } from '../../services/mappers';
import type { MergeCommentRow } from '../../services/db';
import { deleteComment, findComment, updateComment } from '../../services/comments';
import { afterCommentChanged } from '../../services/hooks';
import { findIssue } from '../../services/issues';
import { getTeam } from '../../services/teams';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function publishCommentEvent(c: Ctx, comment: MergeCommentRow, action: 'updated' | 'deleted') {
  publishEntityEvents(c, [
    {
      entityType: 'merge_comment',
      action,
      entityId: comment.id,
      data: { id: comment.id, issueId: comment.issueId, authorUserId: comment.authorUserId },
    },
  ]);
  const db = c.get('tenantDb');
  const issue = await findIssue(db, comment.issueId);
  if (!issue) return;
  const team = await getTeam(db, issue.teamId);
  await afterCommentChanged(hookContext(c), action, comment, issue, team?.row.key ?? '');
}

app.patch('/:id', requirePermission('merge_issues:update'), zValidator('json', updateMergeCommentSchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await findComment(db, id);
  if (!existing) return error.notFound(c, 'Comment', id);
  if (existing.authorUserId !== c.get('userId')) return error.forbidden(c, 'Only the author can edit a comment');
  const comment = await updateComment(db, id, c.req.valid('json').body);
  await publishCommentEvent(c, comment, 'updated');
  return success(c, commentDto(comment));
});

app.delete('/:id', requirePermission('merge_issues:update'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await findComment(db, id);
  if (!existing) return error.notFound(c, 'Comment', id);
  if (existing.authorUserId !== c.get('userId') && !(await hasContextPermission(c, 'merge_issues:delete'))) {
    return error.forbidden(c, 'Only the author, or someone who can delete issues, can delete a comment');
  }
  const comment = await deleteComment(db, id);
  await publishCommentEvent(c, comment, 'deleted');
  return noContent(c);
});

export default app;
