/**
 * Project-control link routes: /api/project-control-links/*, backed by
 * `project_control_links` (ADR FLOW-011). A link joins two objects of a
 * project: a register item, a task or a milestone.
 *
 *   GET    /        links of one object, by its `from` end or its `to` end
 *   POST   /        link two objects
 *   DELETE /:id     remove a link
 *
 * Permissions: projects:read to list, projects:update to link and unlink,
 * plus the membership boundary: both ends must be in projects the caller can
 * write (read for a list). Checks run in a fixed order so every backend
 * answers alike: permission, then the objects (404), then project access
 * (403), then the body (400), then the link rules.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import {
  CONTROL_LINK_TYPES,
  createControlLinkSchema,
  type ControlLinkType,
} from '@weldsuite/app-api-client/schemas/project-control';
import {
  controlLinkEventData,
  linkEndsError,
  linkShapeError,
  presentControlLink,
} from '@weldsuite/flow-domain/raid';
import type { Env, Variables } from '../../types';
import { canAccessProject, canWriteProject } from '../../lib/project-access';
import { presentLinkedObjects, resolveEnd } from '../../services/project-raid';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectControlLinks;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const OBJECT_LABELS: Record<ControlLinkType, string> = {
  raid_item: 'RAID item',
  task: 'Task',
  milestone: 'Milestone',
  decision: 'Decision',
  change_request: 'Change request',
  deliverable: 'Deliverable',
  benefit: 'Benefit',
};

const listQuerySchema = z
  .object({
    fromType: z.enum(CONTROL_LINK_TYPES).optional(),
    fromId: z.string().optional(),
    toType: z.enum(CONTROL_LINK_TYPES).optional(),
    toId: z.string().optional(),
  })
  .strict();

function publishLink(c: AppContext, action: 'created' | 'deleted', row: typeof t.$inferSelect) {
  publishEntityEvent({
    c,
    entityType: 'project_control_link',
    entityId: row.id,
    action,
    data: controlLinkEventData(row),
  });
}

// ── List ────────────────────────────────────────────────────────────────────

type ListQuery = z.infer<typeof listQuerySchema>;

/** The 400 message when the query does not name an object whole, or null. */
function listQueryError(q: ListQuery): string | null {
  if (!!q.fromType !== !!q.fromId) return 'fromType and fromId must be given together';
  if (!!q.toType !== !!q.toId) return 'toType and toId must be given together';
  if (!q.fromType && !q.toType) return 'Give fromType and fromId, or toType and toId';
  return null;
}

/** Each queried object must exist, and the caller must be in its project: the refusal, or null. */
async function queriedObjectsError(c: AppContext, q: ListQuery): Promise<Response | null> {
  const db = c.get('tenantDb');
  for (const [type, id] of [
    [q.fromType, q.fromId],
    [q.toType, q.toId],
  ] as const) {
    if (!type || !id) continue;
    const end = await resolveEnd(db, type, id);
    if (!end) return error.notFound(c, OBJECT_LABELS[type], id);
    if (!(await canAccessProject(c, end.projectId))) return error.forbidden(c, PROJECT_DENIED);
  }
  return null;
}

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = listQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return error.badRequest(c, 'Invalid query parameters', details);
  }
  const q = parsed.data;
  const queryError = listQueryError(q);
  if (queryError) return error.badRequest(c, queryError);

  try {
    const refused = await queriedObjectsError(c, q);
    if (refused) return refused;

    const conditions: SQL[] = [];
    if (q.fromType && q.fromId) conditions.push(eq(t.fromType, q.fromType), eq(t.fromId, q.fromId));
    if (q.toType && q.toId) conditions.push(eq(t.toType, q.toType), eq(t.toId, q.toId));
    const rows = await db
      .select()
      .from(t)
      .where(and(...conditions));
    // Seen from the `from` object when one is given, else from the `to` object.
    const direction = q.fromType ? 'outgoing' : 'incoming';
    return success(
      c,
      await presentLinkedObjects(db, rows, () => direction, (projectId) => canAccessProject(c, projectId)),
    );
  } catch (err) {
    console.error('[flow-api/project-control-links] list failed:', err);
    return error.internal(c, 'Failed to list links');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return error.badRequest(c, 'Invalid JSON body');
  }
  const parsed = createControlLinkSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return error.badRequest(c, 'Invalid request body', details);
  }
  const input = parsed.data;

  const from = { type: input.fromType, id: input.fromId };
  const to = { type: input.toType, id: input.toId };
  const shapeError = linkShapeError({ from, to, relation: input.relation });
  if (shapeError) return error.badRequest(c, shapeError);

  try {
    const [fromEnd, toEnd] = await Promise.all([resolveEnd(db, from.type, from.id), resolveEnd(db, to.type, to.id)]);
    if (!fromEnd) return error.notFound(c, OBJECT_LABELS[from.type], from.id);
    if (!toEnd) return error.notFound(c, OBJECT_LABELS[to.type], to.id);
    // Both ends must be in projects the caller can write, before anything is said about how they relate.
    if (!(await canWriteProject(c, fromEnd.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
    if (toEnd.projectId !== fromEnd.projectId && !(await canWriteProject(c, toEnd.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    const endsError = linkEndsError({ from: fromEnd, to: toEnd, relation: input.relation });
    if (endsError) return error.badRequest(c, endsError);

    const pair = and(eq(t.fromType, from.type), eq(t.fromId, from.id), eq(t.toType, to.type), eq(t.toId, to.id));
    const [existing] = await db.select({ id: t.id }).from(t).where(pair).limit(1);
    if (existing) return error.conflict(c, 'These objects are already linked');

    const row: typeof t.$inferInsert = {
      id: generateId('pcl'),
      projectId: fromEnd.projectId,
      fromType: from.type,
      fromId: from.id,
      toType: to.type,
      toId: to.id,
      relation: input.relation,
      createdBy: userId,
      createdAt: new Date(),
    };
    try {
      await db.insert(t).values(row);
    } catch (err) {
      // Two requests linking the same pair at once: the unique index decides.
      if (isUniqueViolation(err)) return error.conflict(c, 'These objects are already linked');
      throw err;
    }
    const [created] = await db.select().from(t).where(eq(t.id, row.id)).limit(1);
    if (!created) return error.internal(c, 'Failed to create link');
    publishLink(c, 'created', created);
    return success(c, presentControlLink(created), 201);
  } catch (err) {
    console.error('[flow-api/project-control-links] create failed:', err);
    return error.internal(c, 'Failed to create link');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Link', id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
    // The other end may sit in another project (a dependency on a milestone there).
    const toEnd = await resolveEnd(db, existing.toType, existing.toId);
    if (toEnd && toEnd.projectId !== existing.projectId && !(await canWriteProject(c, toEnd.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    await db.delete(t).where(eq(t.id, id));
    publishLink(c, 'deleted', existing);
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-control-links] delete failed:', err);
    return error.internal(c, 'Failed to delete link');
  }
});

export const projectControlLinksRoutes = app;
