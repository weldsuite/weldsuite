/**
 * Baseline routes: /api/project-baselines/*, backed by `project_baselines`
 * (design: weldflow-project-control.md, "Baseline variance"; ADR FLOW-012).
 * Baselines are immutable: v1 is signed off by the project manager, every later
 * version comes from an approved change request (`applyApprovedChange`).
 *
 *   GET    /                                  list (projectId optional, cursor), newest first
 *   GET    /compare                           variance between two versions, or one version and the live plan
 *   GET    /:id                               one version
 *   POST   /projects/:projectId/initial       sign off v1 from the current plan (once)
 *
 * Permissions: projects:read, and projects:update for the sign-off, plus the
 * project membership boundary (FLOW-001): the sign-off is the project manager's
 * (`canManageProject`). Fixed check order: permission, the record (404), project
 * access (403), the body or query (400), then the rules.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { compareBaselinesQuerySchema, listBaselinesQuerySchema } from '@weldsuite/app-api-client/schemas/flow-approvals';
import {
  BASELINE_MESSAGES,
  baselineEventData,
  baselineIsEmpty,
  buildSnapshot,
  compareSnapshots,
  findBaseline,
  latestBaseline,
  loadPlanState,
  presentBaseline,
  type BaselineRow,
} from '@weldsuite/flow-domain/baselines';
import { changeCode, listPendingChanges } from '@weldsuite/flow-domain/changes';
import type { Env, Variables } from '../../types';
import { accessibleProjectIds, canAccessProject, canManageProject, inAccessibleProjects } from '../../lib/project-access';
import { parseLimit } from '../../lib/query-params';
import { findLiveProject } from '../../services/project-changes';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectBaselines;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_EDIT_DENIED = 'You must be a project owner, admin, or manager to edit this project';
const ITEM_LABEL = 'Baseline';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

function readQuery<S extends z.ZodTypeAny>(c: AppContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', details) };
  }
  return { ok: true, data: parsed.data };
}

/** The code and title of the change request behind each baseline version, by baseline id. */
async function changesOf(db: Database, rows: readonly BaselineRow[]): Promise<Map<string, { code: string; title: string }>> {
  const ids = [...new Set(rows.map((row) => row.changeRequestId).filter((id): id is string => !!id))];
  const out = new Map<string, { code: string; title: string }>();
  if (ids.length === 0) return out;
  const found = await db
    .select({ id: schema.projectChangeRequests.id, number: schema.projectChangeRequests.number, title: schema.projectChangeRequests.title })
    .from(schema.projectChangeRequests)
    .where(inArray(schema.projectChangeRequests.id, ids));
  const byId = new Map(found.map((change) => [change.id, change]));
  for (const row of rows) {
    const change = row.changeRequestId ? byId.get(row.changeRequestId) : undefined;
    if (change) out.set(row.id, { code: changeCode(change.number), title: change.title });
  }
  return out;
}

async function presentOne(db: Database, row: BaselineRow) {
  return presentBaseline(row, (await changesOf(db, [row])).get(row.id) ?? null);
}

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listBaselinesQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 25, 100);

  const conditions: SQL[] = [];
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);
    conditions.push(eq(t.projectId, q.projectId));
  } else {
    conditions.push(inAccessibleProjects(t.projectId, await accessibleProjectIds(c)));
  }
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) conditions.push(sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`);
  }
  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    const changes = await changesOf(db, data);
    return list(
      c,
      data.map((row) => presentBaseline(row, changes.get(row.id) ?? null)),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/project-baselines] list failed:', err);
    return error.internal(c, 'Failed to list baselines');
  }
});

// MUST be before /:id.
app.get('/compare', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, compareBaselinesQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  if (!q.projectId && !q.from) return error.badRequest(c, BASELINE_MESSAGES.needsProjectOrFrom);

  try {
    let from: BaselineRow | null;
    if (q.from) {
      from = await findBaseline(db, q.from);
      if (!from) return error.notFound(c, ITEM_LABEL, q.from);
    } else {
      if (!(await canAccessProject(c, q.projectId as string))) return error.forbidden(c, PROJECT_DENIED);
      from = await latestBaseline(db, q.projectId as string);
      if (!from) return error.notFound(c, ITEM_LABEL);
    }
    if (!(await canAccessProject(c, from.projectId))) return error.forbidden(c, PROJECT_DENIED);

    let to: BaselineRow | null = null;
    if (q.to && q.to !== 'current') {
      to = await findBaseline(db, q.to);
      if (!to) return error.notFound(c, ITEM_LABEL, q.to);
      if (to.projectId !== from.projectId) return error.badRequest(c, BASELINE_MESSAGES.differentProjects);
    }
    const plan = to ? null : await loadPlanState(db, from.projectId);
    const toSnapshot = to ? to.snapshot : plan ? buildSnapshot(plan) : { ...from.snapshot, milestones: [], deliverables: [] };

    // What open change requests would do to the live plan, for the dashed previews.
    const pending = [];
    if (!to && plan) {
      for (const change of await listPendingChanges(db, from.projectId)) {
        pending.push({
          changeRequestId: change.id,
          code: changeCode(change.number),
          title: change.title,
          status: change.status as 'assessing' | 'awaiting_approval',
          milestones: (change.planChanges?.milestones ?? []).flatMap((move) => {
            const current = plan.milestones.find((m) => m.id === move.milestoneId);
            return current
              ? [{ milestoneId: move.milestoneId, name: current.name, from: current.dueDate.toISOString(), to: new Date(move.to).toISOString() }]
              : [];
          }),
          deliverables: (change.planChanges?.deliverables ?? []).map((move) => {
            const current = plan.deliverables.find((d) => d.id === move.deliverableId);
            const iso = (value: string | Date | null | undefined) => (value ? new Date(value).toISOString() : null);
            return {
              deliverableId: move.deliverableId,
              plannedStart: move.plannedStart !== undefined ? iso(move.plannedStart) : iso(current?.plannedStart),
              plannedEnd: move.plannedEnd !== undefined ? iso(move.plannedEnd) : iso(current?.plannedEnd),
            };
          }),
          goLive: change.planChanges?.goLive ? new Date(change.planChanges.goLive).toISOString() : null,
        });
      }
    }
    return success(c, {
      from: await presentOne(db, from),
      to: to ? await presentOne(db, to) : null,
      toSnapshot,
      diff: compareSnapshots(from.snapshot, toSnapshot),
      pending,
    });
  } catch (err) {
    console.error('[flow-api/project-baselines] compare failed:', err);
    return error.internal(c, 'Failed to compare baselines');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findBaseline(db, id);
    if (!row) return error.notFound(c, ITEM_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, await presentOne(db, row));
  } catch (err) {
    console.error('[flow-api/project-baselines] get failed:', err);
    return error.internal(c, 'Failed to fetch baseline');
  }
});

// ── Sign off v1 ─────────────────────────────────────────────────────────────

app.post('/projects/:projectId/initial', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  if (!(await findLiveProject(db, projectId))) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_EDIT_DENIED);

  try {
    if (await latestBaseline(db, projectId)) return error.conflict(c, BASELINE_MESSAGES.alreadyBaselined);
    const plan = await loadPlanState(db, projectId);
    if (!plan) return error.notFound(c, 'Project', projectId);
    if (baselineIsEmpty(plan)) return error.badRequest(c, BASELINE_MESSAGES.nothingToBaseline);

    const [row] = await db
      .insert(t)
      .values({ id: generateId('bsl'), projectId, version: 1, changeRequestId: null, snapshot: buildSnapshot(plan), createdBy: userId, createdAt: new Date() })
      .returning();
    if (!row) return error.internal(c, 'Failed to sign off the baseline');
    publishEntityEvent({ c, entityType: 'project_baseline', entityId: row.id, action: 'created', data: baselineEventData(row) });
    return success(c, presentBaseline(row, null), 201);
  } catch (err) {
    console.error('[flow-api/project-baselines] sign off failed:', err);
    return error.internal(c, 'Failed to sign off the baseline');
  }
});


export const projectBaselinesRoutes = app;
