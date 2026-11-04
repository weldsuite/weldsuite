/**
 * Scope routes: /api/project-scope/*, backed by `project_scope` (design:
 * weldflow-project-control.md). One row per project: the scope statement, what
 * is in scope and what is deliberately out, with the reason and, optionally, the
 * decision, change request or project it relates to.
 *
 *   GET /:projectId   the scope (empty before the first save)
 *   PUT /:projectId   save it: created on first save, a list left out stays as it is
 *
 * The versions of scope, plan and budget are the baselines, read from
 * `/api/project-baselines`; this row is the live scope, edited in place.
 *
 * Permissions: projects:read | projects:update, plus the project membership
 * boundary (FLOW-001). The checks run in a fixed order so every backend answers
 * alike: permission, then the project (404), then project access (403), then
 * the body (400), then the business rules.
 */

import { Hono } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { putScopeSchema, type ScopeLinkType } from '@weldsuite/app-api-client/schemas/project-governance';
import {
  SCOPE_MESSAGES,
  normalizeOutOfScope,
  outOfScopeLinkError,
  presentScope,
  scopeEventData,
  scopeLinkKey,
  type ScopeLinkTarget,
} from '@weldsuite/flow-domain/scope';
import { decisionCode } from '@weldsuite/flow-domain/decisions';
import type { Env, Variables } from '../../types';
import { canAccessProject, canWriteProject } from '../../lib/project-access';
import {
  PROJECT_DENIED,
  PROJECT_WRITE_DENIED,
  parseBody,
  type AppContext,
} from '../../lib/governance-request';
import { liveProjectExists } from '../../services/project-raid';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectScope;

type ScopeRow = typeof t.$inferSelect;

async function findScope(db: Database, projectId: string): Promise<ScopeRow | null> {
  const [row] = await db.select().from(t).where(eq(t.projectId, projectId)).limit(1);
  return row ?? null;
}

/**
 * What the out-of-scope links of a project resolve to, by `type:id`. A decision
 * or change request counts only in this project; another project only when the
 * caller can read it (its name is not for everyone). Links that do not resolve
 * are left out.
 */
async function resolveScopeLinks(
  c: AppContext,
  projectId: string,
  items: ReadonlyArray<{ linkType?: string | null; linkId?: string | null }>,
): Promise<Map<string, ScopeLinkTarget>> {
  const db = c.get('tenantDb');
  const wanted: Record<ScopeLinkType, string[]> = { decision: [], change_request: [], project: [] };
  for (const item of items) {
    const key = scopeLinkKey({ linkType: item.linkType ?? null, linkId: item.linkId ?? null });
    if (!key || !item.linkType || !item.linkId) continue;
    const list = wanted[item.linkType as ScopeLinkType];
    if (list && !list.includes(item.linkId)) list.push(item.linkId);
  }
  const out = new Map<string, ScopeLinkTarget>();
  if (wanted.decision.length > 0) {
    const rows = await db
      .select()
      .from(schema.projectDecisions)
      .where(
        and(
          inArray(schema.projectDecisions.id, wanted.decision),
          eq(schema.projectDecisions.projectId, projectId),
          isNull(schema.projectDecisions.deletedAt),
        ),
      );
    for (const row of rows) {
      out.set(`decision:${row.id}`, { type: 'decision', id: row.id, code: decisionCode(row.number), title: row.title, status: row.status });
    }
  }
  if (wanted.change_request.length > 0) {
    const rows = await db
      .select()
      .from(schema.projectChangeRequests)
      .where(
        and(
          inArray(schema.projectChangeRequests.id, wanted.change_request),
          eq(schema.projectChangeRequests.projectId, projectId),
          isNull(schema.projectChangeRequests.deletedAt),
        ),
      );
    for (const row of rows) {
      out.set(`change_request:${row.id}`, {
        type: 'change_request',
        id: row.id,
        code: `CR-${row.number}`,
        title: row.title,
        status: row.status,
      });
    }
  }
  if (wanted.project.length > 0) {
    const rows = await db
      .select({ id: schema.projects.id, name: schema.projects.name, status: schema.projects.status })
      .from(schema.projects)
      .where(and(inArray(schema.projects.id, wanted.project), isNull(schema.projects.deletedAt)));
    for (const row of rows) {
      if (!(await canAccessProject(c, row.id))) continue;
      out.set(`project:${row.id}`, { type: 'project', id: row.id, code: null, title: row.name, status: row.status });
    }
  }
  return out;
}

app.get('/:projectId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  try {
    if (!(await liveProjectExists(db, projectId))) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);

    const row = await findScope(db, projectId);
    const targets = await resolveScopeLinks(c, projectId, row?.outOfScope ?? []);
    return success(c, presentScope(projectId, row, targets));
  } catch (err) {
    console.error('[flow-api/project-scope] get failed:', err);
    return error.internal(c, 'Failed to fetch scope');
  }
});

app.put('/:projectId', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  if (!(await liveProjectExists(db, projectId))) return error.notFound(c, 'Project', projectId);
  if (!(await canWriteProject(c, projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, putScopeSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const linkError = input.outOfScope ? outOfScopeLinkError(input.outOfScope) : null;
  if (linkError) return error.badRequest(c, linkError);

  try {
    const outOfScope = input.outOfScope ? normalizeOutOfScope(input.outOfScope) : undefined;
    if (outOfScope) {
      const targets = await resolveScopeLinks(c, projectId, outOfScope);
      for (const item of outOfScope) {
        const key = scopeLinkKey(item);
        if (key && !targets.has(key)) return error.badRequest(c, SCOPE_MESSAGES.linkNotFound);
      }
    }

    const now = new Date();
    const existing = await findScope(db, projectId);
    const values = {
      statement: input.statement !== undefined ? input.statement : (existing?.statement ?? null),
      inScope: input.inScope ?? existing?.inScope ?? [],
      outOfScope: outOfScope ?? existing?.outOfScope ?? [],
      updatedBy: userId,
      updatedAt: now,
    };
    await db
      .insert(t)
      .values({ id: generateId('scope'), projectId, ...values, createdBy: userId, createdAt: now })
      .onConflictDoUpdate({ target: t.projectId, set: values });
    const row = await findScope(db, projectId);
    if (!row) return error.internal(c, 'Failed to save scope');

    publishEntityEvent({
      c,
      entityType: 'project_scope',
      entityId: row.id,
      action: existing ? 'updated' : 'created',
      data: scopeEventData(row),
    });
    return success(c, presentScope(projectId, row, await resolveScopeLinks(c, projectId, row.outOfScope)));
  } catch (err) {
    console.error('[flow-api/project-scope] save failed:', err);
    return error.internal(c, 'Failed to save scope');
  }
});

export const projectScopeRoutes = app;
