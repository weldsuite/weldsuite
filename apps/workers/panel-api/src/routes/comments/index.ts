/**
 * Comments on reports and dashboards: /api/panel/comments/*.
 *
 *   GET    /       → ?targetType&targetId: the target's comments, oldest first
 *   POST   /       → new comment; the target's owner gets an in-app notification (unless it is theirs)
 *   PATCH  /:id    → change the body (the author)
 *   DELETE /:id    → soft delete (the author, or `panel_projects:manage`)
 *
 * Only someone who may see the target reads or writes its comments; any other
 * target is a 404. `panel_reports:read` to read, `:create` / `:update` /
 * `:delete` to write.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelCommentSchema,
  panelTargetQuerySchema,
  updatePanelCommentSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelComment } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { canSee, getTarget, type Actor, type PanelTarget } from '../../services/saved-objects';
import {
  commentEventData,
  createComment,
  deleteComment,
  getComment,
  listComments,
  notifyTargetOwner,
  toCommentDto,
  updateComment,
} from '../../services/comments';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

function publish(c: Ctx, comment: PanelComment, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_comment', entityId: comment.id, action, data: commentEventData(comment) });
}

/** The target when the caller may see it, else null. */
async function visibleTarget(c: Ctx, targetType: 'report' | 'dashboard', targetId: string): Promise<PanelTarget | null> {
  const target = await getTarget(c.get('tenantDb'), targetType, targetId);
  return target && canSee(target.row, await actorOf(c)) ? target : null;
}

/** The comment when the caller may see its target, or the answer to send instead. */
async function visibleComment(c: Ctx): Promise<PanelComment | Response> {
  const id = c.req.param('id') ?? '';
  const comment = await getComment(c.get('tenantDb'), id);
  if (!comment || !(await visibleTarget(c, comment.targetType, comment.targetId))) return error.notFound(c, 'Comment', id);
  return comment;
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', panelTargetQuerySchema), async (c) => {
  const { targetType, targetId } = c.req.valid('query');
  if (!(await visibleTarget(c, targetType, targetId))) return error.notFound(c, targetType === 'report' ? 'Report' : 'Dashboard', targetId);
  const comments = await listComments(c.get('tenantDb'), targetType, targetId);
  return list(c, comments.map(toCommentDto), cursorPagination(comments.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelCommentSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const target = await visibleTarget(c, input.targetType, input.targetId);
  if (!target) return error.notFound(c, input.targetType === 'report' ? 'Report' : 'Dashboard', input.targetId);

  const comment = await createComment(db, target, input.body, userId);
  publish(c, comment, 'created');
  const clerkOrgId = c.get('clerkOrgId');
  if (clerkOrgId && target.row.ownerUserId !== userId) {
    c.executionCtx.waitUntil(notifyTargetOwner({ env: c.env, db, clerkOrgId, target, comment }));
  }
  return success(c, toCommentDto(comment), 201);
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelCommentSchema), async (c) => {
  const found = await visibleComment(c);
  if (found instanceof Response) return found;
  if (found.authorUserId !== c.get('userId')) return error.forbidden(c, 'Only the author can change this comment');
  const comment = await updateComment(c.get('tenantDb'), found.id, c.req.valid('json').body);
  if (!comment) return error.notFound(c, 'Comment', found.id);
  publish(c, comment, 'updated');
  return success(c, toCommentDto(comment));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const found = await visibleComment(c);
  if (found instanceof Response) return found;
  const actor = await actorOf(c);
  if (found.authorUserId !== actor.userId && !actor.canManage) return error.forbidden(c, 'Only the author can delete this comment');
  const comment = await deleteComment(c.get('tenantDb'), found.id);
  if (!comment) return error.notFound(c, 'Comment', found.id);
  publish(c, comment, 'deleted');
  return noContent(c);
});

export default app;
