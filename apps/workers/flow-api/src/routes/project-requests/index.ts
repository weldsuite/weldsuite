/**
 * Project intake routes: /api/project-requests/*, backed by
 * `project_requests` and `flow_workspace_settings` (design:
 * weldflow-delivery-and-portfolio.md, "Intake").
 *
 *   GET    /                ranked list (status, search, cursor)
 *   GET    /funnel          requests per status
 *   GET    /roadmap         current projects and approved requests per quarter, with the capacity line
 *   GET    /settings        scoring model, portfolio board, expense approval limit
 *   PUT    /settings        change them (portfolio:manage); a new model re-scores open requests
 *   GET    /:id             request, score breakdown, board answers, capacity fit
 *   POST   /                file a request (REQ-n)
 *   PATCH  /:id             edit a new or assessing request
 *   DELETE /:id             soft delete, with its held bookings and open approvals
 *   POST   /:id/score       rate the criteria of the scoring model
 *   POST   /:id/submit      ask every portfolio board member to approve
 *   POST   /:id/convert     link the project made from an approved request
 *
 * Intake is workspace-level: reading it needs `portfolio:read`, the scoring
 * model and the board `portfolio:manage`. A request is changed by whoever
 * filed it (or `portfolio:manage`), and scored by the portfolio board (or
 * `portfolio:manage`). Approval goes through the approvals core (subject type
 * `project_request`, FLOW-016): the board answers in My reviews, and the
 * request becomes `approved` or `rejected` when the rows settle it. The checks
 * run in a fixed order so every backend answers alike: permission, then the
 * row (404), then access (403), then the body (400), then the rules.
 */

import { Hono } from 'hono';
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  PROJECT_REQUEST_STATUSES,
  convertProjectRequestSchema,
  createProjectRequestSchema,
  listProjectRequestsQuerySchema,
  roadmapQuerySchema,
  scoreProjectRequestSchema,
  updateFlowSettingsSchema,
  updateProjectRequestSchema,
  OTHER_PROJECT_NAME,
  type IntakeFunnel,
  type ProjectRequestStatus,
  type RoadmapItem,
} from '@weldsuite/app-api-client/schemas/flow-portfolio';
import { fitRange, presentBooking, roadmapRange, rollupLoad, skillFit, weeksCovering } from '@weldsuite/flow-domain/capacity';
import {
  DEFAULT_SCORING_MODEL,
  INTAKE_MESSAGES,
  REQUEST_SEQUENCE,
  amountText,
  desiredDatesError,
  isOpenRequestStatus,
  normalizeNeededSkills,
  presentProjectRequest,
  presentRequestApproval,
  presentSettings,
  requestCode,
  scoreBreakdown,
  scoreRequest,
  scoresError,
  scoringModelError,
  sortRoadmapItems,
} from '@weldsuite/flow-domain/intake';
import { listSubjectApprovals, requestApprovals, cancelPendingApprovals } from '@weldsuite/flow-domain/approvals';
import { announceApprovalsCancelled, announceApprovalsRequested } from '../../services/approvals';
import { allocateNumber } from '@weldsuite/flow-domain/task-numbering';
import type { Env, Variables } from '../../types';
import { accessibleProjectIds, canManageProject } from '../../lib/project-access';
import { containsPattern, parseLimit } from '../../lib/query-params';
import { flag, parseBody, readQuery, todayUtc, type PortfolioContext } from '../../lib/portfolio-request';
import { CURRENT_PROJECT_STATUSES, liveProjectExists, loadCapacity } from '../../services/capacity';
import {
  boardOf,
  findProjectRequest,
  loadSettings,
  modelOf,
  type NewProjectRequestRow,
  type ProjectRequestRow,
} from '../../services/project-requests';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectRequests;
const settingsTable = schema.flowWorkspaceSettings;
const approvalsTable = schema.flowApprovals;
const bookings = schema.resourceBookings;

const REQUEST_LABEL = 'Project request';
const DAY_MS = 86_400_000;

type Ctx = PortfolioContext;

// ── Access and events ───────────────────────────────────────────────────────

const canManagePortfolio = (c: Ctx) => hasContextPermission(c, 'portfolio:manage');

/** Whoever filed the request, or `portfolio:manage`. */
async function mayChange(c: Ctx, row: ProjectRequestRow): Promise<boolean> {
  return row.requestedBy === c.get('userId') || (await canManagePortfolio(c));
}

function publishRequest(
  c: Ctx,
  action: 'created' | 'updated' | 'deleted' | 'submitted' | 'converted',
  row: ProjectRequestRow,
) {
  publishEntityEvent({
    c,
    entityType: 'project_request',
    entityId: row.id,
    action,
    data: { ...presentProjectRequest(row) },
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listProjectRequestsQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 100, 200);

  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.search) {
    const pattern = containsPattern(q.search);
    conditions.push(or(ilike(t.title, pattern), ilike(t.businessCase, pattern)) as SQL);
  }
  const countWhere = and(...conditions);
  // Ranked: the highest score first, requests without one last, ties by number.
  if (q.cursor) {
    const [cur] = await db
      .select({ number: t.number, score: sql<string>`coalesce(${t.score}, -1)::text` })
      .from(t)
      .where(eq(t.id, q.cursor))
      .limit(1);
    if (cur) {
      conditions.push(
        sql`(coalesce(${t.score}, -1) < ${cur.score}::numeric OR (coalesce(${t.score}, -1) = ${cur.score}::numeric AND ${t.number} > ${cur.number}))`,
      );
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select()
        .from(t)
        .where(and(...conditions))
        .orderBy(sql`coalesce(${t.score}, -1) desc`, asc(t.number))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data.map(presentProjectRequest), cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[flow-api/project-requests] list failed:', err);
    return error.internal(c, 'Failed to list project requests');
  }
});

// MUST be before /:id.
app.get('/funnel', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const [byStatus, [recent], [oldest]] = await Promise.all([
      db
        .select({ status: t.status, count: sql<number>`count(*)`.mapWith(Number) })
        .from(t)
        .where(isNull(t.deletedAt))
        .groupBy(t.status),
      db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(t)
        .where(and(isNull(t.deletedAt), eq(t.status, 'new'), sql`${t.createdAt} >= ${weekAgo}`)),
      db
        .select({ at: sql<Date | null>`min(${t.submittedAt})` })
        .from(t)
        .where(and(isNull(t.deletedAt), eq(t.status, 'assessing'))),
    ]);
    const counts = Object.fromEntries(PROJECT_REQUEST_STATUSES.map((status) => [status, 0])) as Record<ProjectRequestStatus, number>;
    for (const row of byStatus) counts[row.status] = row.count;
    const oldestAt = oldest?.at ? new Date(oldest.at) : null;
    const funnel: IntakeFunnel = {
      counts,
      newLast7Days: recent?.count ?? 0,
      oldestAssessingDays: oldestAt ? Math.max(0, Math.floor((now.getTime() - oldestAt.getTime()) / DAY_MS)) : null,
    };
    return success(c, funnel);
  } catch (err) {
    console.error('[flow-api/project-requests] funnel failed:', err);
    return error.internal(c, 'Failed to load the intake funnel');
  }
});

// MUST be before /:id.
app.get('/roadmap', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, roadmapQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const range = roadmapRange(q.from, q.to, todayUtc());
  if ('error' in range) return error.badRequest(c, range.error);
  const includeTentative = flag(q.tentative);

  try {
    const p = schema.projects;
    const projectStart = sql`least(${p.startDate}, ${p.endDate})`;
    const projectEnd = sql`greatest(${p.startDate}, ${p.endDate})`;
    const requestStart = sql`least(${t.desiredStart}, ${t.desiredEnd})`;
    const requestEnd = sql`greatest(${t.desiredStart}, ${t.desiredEnd})`;
    const [projectRows, requestRows, accessible] = await Promise.all([
      db
        .select({
          id: p.id,
          name: p.name,
          status: p.status,
          startsOn: sql<string>`to_char(${projectStart}, 'YYYY-MM-DD')`,
          endsOn: sql<string>`to_char(${projectEnd}, 'YYYY-MM-DD')`,
        })
        .from(p)
        .where(
          and(
            isNull(p.deletedAt),
            inArray(p.status, [...CURRENT_PROJECT_STATUSES]),
            sql`${projectStart}::date <= ${range.to}::date`,
            sql`${projectEnd}::date >= ${range.from}::date`,
          ),
        )
        .orderBy(asc(p.id)),
      db
        .select({
          id: t.id,
          number: t.number,
          title: t.title,
          status: t.status,
          score: t.score,
          startsOn: sql<string>`to_char(${requestStart}, 'YYYY-MM-DD')`,
          endsOn: sql<string>`to_char(${requestEnd}, 'YYYY-MM-DD')`,
        })
        .from(t)
        .where(
          and(
            isNull(t.deletedAt),
            inArray(t.status, ['assessing', 'approved']),
            sql`${requestStart}::date <= ${range.to}::date`,
            sql`${requestEnd}::date >= ${range.from}::date`,
          ),
        )
        .orderBy(asc(t.id)),
      accessibleProjectIds(c),
    ]);
    const allowed = accessible === null ? null : new Set(accessible);
    const items: RoadmapItem[] = [
      ...projectRows.map((row) => {
        const mayAccess = allowed === null || allowed.has(row.id);
        return {
          type: 'project' as const,
          id: row.id,
          code: null,
          name: mayAccess ? row.name : OTHER_PROJECT_NAME,
          accessible: mayAccess,
          status: row.status,
          startsOn: row.startsOn,
          endsOn: row.endsOn,
          score: null,
        };
      }),
      ...requestRows.map((row) => ({
        type: 'request' as const,
        id: row.id,
        code: `${REQUEST_SEQUENCE.prefix}${row.number}`,
        name: row.title,
        accessible: true,
        status: row.status,
        startsOn: row.startsOn,
        endsOn: row.endsOn,
        score: row.score === null ? null : Number(row.score),
      })),
    ];

    // The team's load over the same weeks, rolled up to quarters and months.
    const span = weeksCovering(range.from, range.to);
    const load = await loadCapacity(db, span, { includeTentative });
    return success(c, {
      from: range.from,
      to: range.to,
      quarters: rollupLoad(load, range.from, range.to, true),
      months: rollupLoad(load, range.from, range.to, false),
      items: sortRoadmapItems(items),
    });
  } catch (err) {
    console.error('[flow-api/project-requests] roadmap failed:', err);
    return error.internal(c, 'Failed to load the roadmap');
  }
});

// ── Workspace settings ──────────────────────────────────────────────────────

// MUST be before /:id.
app.get('/settings', requirePermission('portfolio:read'), async (c) => {
  try {
    return success(c, presentSettings(await loadSettings(c.get('tenantDb'))));
  } catch (err) {
    console.error('[flow-api/project-requests] get settings failed:', err);
    return error.internal(c, 'Failed to fetch intake settings');
  }
});

app.put('/settings', requirePermission('portfolio:manage'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, updateFlowSettingsSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (input.scoringModel) {
    const modelError = scoringModelError(input.scoringModel);
    if (modelError) return error.badRequest(c, modelError);
  }

  try {
    const now = new Date();
    const board = input.portfolioBoardIds === undefined ? undefined : [...new Set(input.portfolioBoardIds)];
    const limit = input.expenseApprovalLimit === undefined ? undefined : amountText(input.expenseApprovalLimit);

    // A new model re-ranks every open request: the stored scores follow it.
    const rescored: Array<{ row: ProjectRequestRow; score: number | null }> = [];
    if (input.scoringModel) {
      const open = await db
        .select()
        .from(t)
        .where(and(isNull(t.deletedAt), inArray(t.status, ['new', 'assessing'])))
        .orderBy(asc(t.number));
      for (const row of open) {
        const score = scoreRequest(input.scoringModel, row.scores);
        const before = row.score === null ? null : Number(row.score);
        if (score !== before) rescored.push({ row, score });
      }
    }

    await atomically(db, (handle) => [
      handle
        .insert(settingsTable)
        .values({
          id: generateId('fws'),
          singleton: true,
          scoringModel: input.scoringModel ?? [...DEFAULT_SCORING_MODEL],
          portfolioBoardIds: board ?? [],
          expenseApprovalLimit: limit ?? null,
          updatedBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settingsTable.singleton,
          set: {
            ...(input.scoringModel ? { scoringModel: input.scoringModel } : {}),
            ...(board === undefined ? {} : { portfolioBoardIds: board }),
            ...(limit === undefined ? {} : { expenseApprovalLimit: limit }),
            updatedBy: userId,
            updatedAt: now,
          },
        }),
      ...rescored.map(({ row, score }) =>
        handle
          .update(t)
          .set({ score: score === null ? null : score.toFixed(2), updatedAt: now })
          .where(eq(t.id, row.id)),
      ),
    ]);
    const settings = await loadSettings(db);
    if (!settings) return error.internal(c, 'Failed to save intake settings');

    publishEntityEvent({
      c,
      entityType: 'flow_workspace_settings',
      entityId: settings.id,
      action: 'updated',
      data: { ...presentSettings(settings) },
    });
    for (const { row } of rescored) {
      const updated = await findProjectRequest(db, row.id);
      if (updated) publishRequest(c, 'updated', updated);
    }
    return success(c, presentSettings(settings));
  } catch (err) {
    console.error('[flow-api/project-requests] save settings failed:', err);
    return error.internal(c, 'Failed to save intake settings');
  }
});

// ── Detail ──────────────────────────────────────────────────────────────────

app.get('/:id', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findProjectRequest(db, id);
    if (!row) return error.notFound(c, REQUEST_LABEL, id);
    const model = modelOf(await loadSettings(db));
    const approvals = await listSubjectApprovals(db, 'project_request', id);

    // Free capacity of the skills the request needs, over the weeks it wants to run.
    const window = fitRange(row.desiredStart, row.desiredEnd, todayUtc());
    const fit =
      row.neededSkills.length > 0
        ? skillFit(await loadCapacity(db, window, { includeTentative: true }), row.neededSkills)
        : [];
    return success(c, {
      ...presentProjectRequest(row),
      breakdown: scoreBreakdown(model, row.scores),
      approvals: approvals.map(presentRequestApproval),
      fit,
      fitWindow: { from: window.from, to: window.to },
    });
  } catch (err) {
    console.error('[flow-api/project-requests] get failed:', err);
    return error.internal(c, 'Failed to fetch project request');
  }
});

// ── Create, edit, delete ────────────────────────────────────────────────────

app.post('/', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createProjectRequestSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const dateError = desiredDatesError(input.desiredStart, input.desiredEnd);
  if (dateError) return error.badRequest(c, dateError);

  try {
    const now = new Date();
    const id = generateId('prq');
    const number = await allocateNumber(db, REQUEST_SEQUENCE);
    const values: NewProjectRequestRow = {
      id,
      number,
      title: input.title,
      requestedBy: userId,
      businessCase: input.businessCase ?? null,
      estimatedCost: amountText(input.estimatedCost),
      estimatedValue: amountText(input.estimatedValue),
      scores: {},
      score: null,
      neededSkills: normalizeNeededSkills(input.neededSkills ?? []),
      desiredStart: input.desiredStart ?? null,
      desiredEnd: input.desiredEnd ?? null,
      status: 'new',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    await atomically(db, (handle) => [handle.insert(t).values(values)]);
    const row = await findProjectRequest(db, id);
    if (!row) return error.internal(c, 'Failed to create project request');
    publishRequest(c, 'created', row);
    return success(c, presentProjectRequest(row), 201);
  } catch (err) {
    console.error('[flow-api/project-requests] create failed:', err);
    return error.internal(c, 'Failed to create project request');
  }
});

app.patch('/:id', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findProjectRequest(db, id);
  if (!existing) return error.notFound(c, REQUEST_LABEL, id);
  if (!(await mayChange(c, existing))) return error.forbidden(c, INTAKE_MESSAGES.requestForbidden);
  const body = await parseBody(c, updateProjectRequestSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (!isOpenRequestStatus(existing.status)) return error.conflict(c, INTAKE_MESSAGES.notEditable);

  const desiredStart = input.desiredStart !== undefined ? input.desiredStart : existing.desiredStart;
  const desiredEnd = input.desiredEnd !== undefined ? input.desiredEnd : existing.desiredEnd;
  const dateError = desiredDatesError(desiredStart, desiredEnd);
  if (dateError) return error.badRequest(c, dateError);

  try {
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({
          title: input.title ?? existing.title,
          businessCase: input.businessCase !== undefined ? input.businessCase : existing.businessCase,
          estimatedCost: input.estimatedCost !== undefined ? amountText(input.estimatedCost) : existing.estimatedCost,
          estimatedValue: input.estimatedValue !== undefined ? amountText(input.estimatedValue) : existing.estimatedValue,
          neededSkills: input.neededSkills !== undefined ? normalizeNeededSkills(input.neededSkills) : existing.neededSkills,
          desiredStart,
          desiredEnd,
          updatedAt: now,
        })
        .where(and(eq(t.id, id), isNull(t.deletedAt))),
    ]);
    const row = await findProjectRequest(db, id);
    if (!row) return error.notFound(c, REQUEST_LABEL, id);
    publishRequest(c, 'updated', row);
    return success(c, presentProjectRequest(row));
  } catch (err) {
    console.error('[flow-api/project-requests] update failed:', err);
    return error.internal(c, 'Failed to update project request');
  }
});

app.delete('/:id', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findProjectRequest(db, id);
  if (!existing) return error.notFound(c, REQUEST_LABEL, id);
  if (!(await mayChange(c, existing))) return error.forbidden(c, INTAKE_MESSAGES.requestForbidden);
  if (existing.status === 'converted') return error.conflict(c, INTAKE_MESSAGES.notDeletable);

  try {
    // Bookings held for the request and the board's open reviews go with it.
    const held = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.requestId, id), isNull(bookings.deletedAt)))
      .orderBy(asc(bookings.id));
    const reviews = await listSubjectApprovals(db, 'project_request', id);
    const now = new Date();
    await atomically(db, (handle) => [
      handle.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt))),
      handle
        .update(bookings)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(bookings.requestId, id), isNull(bookings.deletedAt))),
      handle
        .update(approvalsTable)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(approvalsTable.subjectType, 'project_request'), eq(approvalsTable.subjectId, id), isNull(approvalsTable.deletedAt))),
    ]);
    publishRequest(c, 'deleted', existing);
    for (const booking of held) {
      publishEntityEvent({
        c,
        entityType: 'resource_booking',
        entityId: booking.id,
        action: 'deleted',
        data: { ...presentBooking(booking) },
      });
    }
    announceApprovalsCancelled(c, reviews);
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-requests] delete failed:', err);
    return error.internal(c, 'Failed to delete project request');
  }
});

// ── Score ───────────────────────────────────────────────────────────────────

app.post('/:id/score', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findProjectRequest(db, id);
  if (!existing) return error.notFound(c, REQUEST_LABEL, id);
  const settings = await loadSettings(db);
  if (!boardOf(settings).includes(userId) && !(await canManagePortfolio(c))) {
    return error.forbidden(c, INTAKE_MESSAGES.scoreForbidden);
  }
  const body = await parseBody(c, scoreProjectRequestSchema);
  if (!body.ok) return body.response;
  if (!isOpenRequestStatus(existing.status)) return error.conflict(c, INTAKE_MESSAGES.notScorable);

  const model = modelOf(settings);
  const unknown = scoresError(model, body.data.scores);
  if (unknown) return error.badRequest(c, unknown);

  try {
    const now = new Date();
    const score = scoreRequest(model, body.data.scores);
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({ scores: body.data.scores, score: score === null ? null : score.toFixed(2), updatedAt: now })
        .where(and(eq(t.id, id), isNull(t.deletedAt))),
    ]);
    const row = await findProjectRequest(db, id);
    if (!row) return error.notFound(c, REQUEST_LABEL, id);
    publishRequest(c, 'updated', row);
    return success(c, { ...presentProjectRequest(row), breakdown: scoreBreakdown(model, row.scores) });
  } catch (err) {
    console.error('[flow-api/project-requests] score failed:', err);
    return error.internal(c, 'Failed to score project request');
  }
});

// ── Submit ──────────────────────────────────────────────────────────────────

app.post('/:id/submit', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findProjectRequest(db, id);
  if (!existing) return error.notFound(c, REQUEST_LABEL, id);
  if (!(await mayChange(c, existing))) return error.forbidden(c, INTAKE_MESSAGES.requestForbidden);
  if (existing.status !== 'new') return error.conflict(c, INTAKE_MESSAGES.notNew);
  const board = [...new Set(boardOf(await loadSettings(db)))];
  if (board.length === 0) return error.badRequest(c, INTAKE_MESSAGES.noBoard);

  let moved = false;
  try {
    const now = new Date();
    // Only a new request moves, so two submits at once cannot both ask the board.
    const claimed = await db
      .update(t)
      .set({ status: 'assessing', submittedAt: now, updatedAt: now })
      .where(and(eq(t.id, id), eq(t.status, 'new'), isNull(t.deletedAt)))
      .returning({ id: t.id });
    if (claimed.length === 0) return error.conflict(c, INTAKE_MESSAGES.notNew);
    moved = true;

    const asked = await requestApprovals(db, {
      projectId: null,
      subjectType: 'project_request',
      subjectId: id,
      requestedBy: userId,
      rows: board.map((approverId) => ({
        approverId,
        roleLabel: 'Portfolio board',
        step: 1,
        rule: { code: 'project_request' },
      })),
      now,
    });
    if (!asked.ok) throw new Error(asked.message);

    const row = await findProjectRequest(db, id);
    if (!row) return error.internal(c, 'Failed to submit project request');
    publishRequest(c, 'submitted', row);
    announceApprovalsRequested(c, { rows: asked.rows, subject: { code: requestCode(row.number), title: row.title } });
    return success(c, { ...presentProjectRequest(row), approvals: asked.rows.map(presentRequestApproval) });
  } catch (err) {
    console.error('[flow-api/project-requests] submit failed:', err);
    if (moved) {
      // Back to new, with no half-asked board.
      await cancelPendingApprovals(db, { subjectType: 'project_request', subjectId: id, includeDecided: true }).catch(
        (undoErr: unknown) => console.error('[flow-api/project-requests] approval rollback failed:', undoErr),
      );
      await db
        .update(t)
        .set({ status: 'new', submittedAt: null, updatedAt: new Date() })
        .where(and(eq(t.id, id), eq(t.status, 'assessing')))
        .catch((undoErr: unknown) => console.error('[flow-api/project-requests] submit rollback failed:', undoErr));
    }
    return error.internal(c, 'Failed to submit project request');
  }
});

// ── Convert ─────────────────────────────────────────────────────────────────

app.post('/:id/convert', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findProjectRequest(db, id);
  if (!existing) return error.notFound(c, REQUEST_LABEL, id);
  const body = await parseBody(c, convertProjectRequestSchema);
  if (!body.ok) return body.response;
  const { projectId } = body.data;

  if (!(await liveProjectExists(db, projectId))) return error.notFound(c, 'Project', projectId);
  if (!(await canManagePortfolio(c)) && !(await canManageProject(c, projectId))) {
    return error.forbidden(c, INTAKE_MESSAGES.convertForbidden);
  }
  if (existing.status !== 'approved') return error.conflict(c, INTAKE_MESSAGES.notApproved);
  const [linked] = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.projectId, projectId), isNull(t.deletedAt)))
    .limit(1);
  if (linked) return error.conflict(c, INTAKE_MESSAGES.projectLinked);

  try {
    // The people held tentatively for the request move onto the project.
    const held = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.requestId, id), isNull(bookings.deletedAt)))
      .orderBy(asc(bookings.id));
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({ status: 'converted', projectId, updatedAt: now })
        .where(and(eq(t.id, id), eq(t.status, 'approved'), isNull(t.deletedAt))),
      handle
        .update(bookings)
        .set({ projectId, requestId: null, updatedAt: now })
        .where(and(eq(bookings.requestId, id), isNull(bookings.deletedAt))),
    ]);
    const row = await findProjectRequest(db, id);
    if (!row) return error.notFound(c, REQUEST_LABEL, id);
    publishRequest(c, 'converted', row);
    for (const booking of held) {
      const [moved] = await db.select().from(bookings).where(eq(bookings.id, booking.id)).limit(1);
      if (!moved) continue;
      publishEntityEvent({
        c,
        entityType: 'resource_booking',
        entityId: moved.id,
        action: 'updated',
        data: { ...presentBooking(moved) },
      });
    }
    return success(c, presentProjectRequest(row));
  } catch (err) {
    console.error('[flow-api/project-requests] convert failed:', err);
    return error.internal(c, 'Failed to convert project request');
  }
});

export const projectRequestsRoutes = app;
