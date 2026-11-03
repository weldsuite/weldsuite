/**
 * Benefit routes: /api/project-benefits/*, backed by `project_benefits` and
 * `project_benefit_measurements` (design: weldflow-project-control.md; ADRs
 * FLOW-011 and FLOW-014).
 *
 *   GET    /                    list (projectId optional, filters, cursor), each with its newest measurement
 *   GET    /goal-targets        progress of the goal-card targets of a project
 *   GET    /:id                 benefit, its measurements (oldest month first) and links
 *   POST   /                    create (code B-<n>, a metric of the catalogue or manual)
 *   PATCH  /:id                 edit; realised and closed stop the measuring
 *   DELETE /:id                 soft delete, with its links
 *   GET    /:id/measurements    the measurements, oldest month first
 *   POST   /:id/measurements    a manual value for a month
 *
 * The monthly sweep (cron/benefit-measure.ts) stores the catalogue metrics'
 * values; creating or editing a benefit with one marks the workspace due for the
 * next month boundary.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete,
 * plus the project membership boundary (FLOW-001). The checks run in a fixed
 * order so every backend answers alike: permission, then the benefit (404),
 * then project access (403), then the body (400), then the business rules.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  BENEFIT_STATUSES,
  createBenefitSchema,
  createMeasurementSchema,
  goalTargetsQuerySchema,
  updateBenefitSchema,
  type GoalCardTargets,
} from '@weldsuite/app-api-client/schemas/project-governance';
import {
  METRIC_CATALOGUE,
  isFuturePeriod,
  isMetric,
  metricIsMeasured,
  metricParamsError,
} from '@weldsuite/flow-domain/benefit-metrics';
import {
  BENEFIT_MESSAGES,
  benefitClosedAtFor,
  benefitCode,
  benefitEventData,
  benefitSequence,
  benefitTargetProgress,
  goalCardId,
  latestOf,
  parseGoalTargets,
  presentBenefit,
  presentMeasurement,
  taskTargetProgress,
} from '@weldsuite/flow-domain/benefits';
import { controlLinkEventData } from '@weldsuite/flow-domain/raid';
import { allocateNumber } from '@weldsuite/flow-domain/task-numbering';
import type { Env, Variables } from '../../types';
import {
  accessibleProjectIds,
  canAccessProject,
  canWriteProject,
  inAccessibleProjects,
} from '../../lib/project-access';
import {
  PROJECT_DENIED,
  PROJECT_WRITE_DENIED,
  numeric,
  parseBody,
  readQuery,
  toDate,
  type AppContext,
} from '../../lib/governance-request';
import { markBenefitMeasureDue } from '../../lib/benefit-measure';
import { containsPattern, parseLimit } from '../../lib/query-params';
import { liveProjectExists, linksOfObject, presentLinkedObjects } from '../../services/project-raid';
import {
  countFilteredTasks,
  findBenefit,
  findGoalsCanvas,
  latestMeasurements,
  measurementsOf,
  newBenefitValues,
  presentBenefitRow,
  upsertMeasurement,
  type BenefitRow,
} from '../../services/project-benefits';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectBenefits;
const linksTable = schema.projectControlLinks;

const BENEFIT_LABEL = 'Benefit';

const listQuerySchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(BENEFIT_STATUSES).optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// ── Events ──────────────────────────────────────────────────────────────────

function publishBenefit(
  c: AppContext,
  action: 'created' | 'updated' | 'deleted' | 'realised',
  row: BenefitRow,
  extra: Record<string, unknown> = {},
) {
  publishEntityEvent({
    c,
    entityType: 'project_benefit',
    entityId: row.id,
    action,
    data: { ...benefitEventData(row), ...extra },
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 25, 100);

  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);
    conditions.push(eq(t.projectId, q.projectId));
  } else {
    conditions.push(inAccessibleProjects(t.projectId, await accessibleProjectIds(c)));
  }
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.search) {
    const pattern = containsPattern(q.search);
    conditions.push(or(ilike(t.title, pattern), ilike(t.description, pattern)) as SQL);
  }
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) {
      conditions.push(sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`);
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const latest = await latestMeasurements(db, data.map((row) => row.id));
    return list(
      c,
      data.map((row) => {
        const newest = latest.get(row.id);
        return presentBenefit(row, latestOf(newest ? [newest] : []));
      }),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/project-benefits] list failed:', err);
    return error.internal(c, 'Failed to list benefits');
  }
});

// MUST be before /:id.
app.get('/goal-targets', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, goalTargetsQuerySchema);
  if (!query.ok) return query.response;
  const { projectId } = query.data;
  try {
    if (!(await liveProjectExists(db, projectId))) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);

    const canvas = await findGoalsCanvas(db, projectId);
    const cards = (canvas?.goals ?? [])
      .map((card) => ({ goalId: goalCardId(card), targets: parseGoalTargets(card) }))
      .filter((card): card is { goalId: string; targets: ReturnType<typeof parseGoalTargets> } => !!card.goalId && card.targets.length > 0);

    const benefitIds = [
      ...new Set(
        cards.flatMap((card) => card.targets.flatMap(({ target }) => ('benefitId' in target ? [target.benefitId] : []))),
      ),
    ];
    const benefitRows = benefitIds.length
      ? await db
          .select()
          .from(t)
          .where(and(eq(t.projectId, projectId), isNull(t.deletedAt), inArray(t.id, benefitIds)))
      : [];
    const latest = await latestMeasurements(db, benefitRows.map((row) => row.id));
    const benefits = new Map(
      benefitRows.map((row) => {
        const newest = latest.get(row.id);
        return [row.id, presentBenefit(row, latestOf(newest ? [newest] : []))] as const;
      }),
    );

    const result: GoalCardTargets[] = [];
    for (const card of cards) {
      const targets = [];
      for (const { index, target } of card.targets) {
        if ('benefitId' in target) {
          targets.push(benefitTargetProgress(index, target.benefitId, benefits.get(target.benefitId) ?? null));
        } else {
          const counts = await countFilteredTasks(db, projectId, target.taskFilter);
          targets.push(taskTargetProgress(index, target.label, counts.done, counts.total));
        }
      }
      result.push({ goalId: card.goalId, targets });
    }
    return success(c, result);
  } catch (err) {
    console.error('[flow-api/project-benefits] goal targets failed:', err);
    return error.internal(c, 'Failed to load goal targets');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findBenefit(db, id);
    if (!row) return error.notFound(c, BENEFIT_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);

    const [measurementRows, linkRows] = await Promise.all([measurementsOf(db, id), linksOfObject(db, 'benefit', id)]);
    const links = await presentLinkedObjects(
      db,
      linkRows,
      (link) => (link.fromType === 'benefit' && link.fromId === id ? 'outgoing' : 'incoming'),
      (projectId) => canAccessProject(c, projectId),
    );
    return success(c, {
      ...presentBenefit(row, latestOf(measurementRows)),
      measurements: measurementRows.map(presentMeasurement),
      links,
    });
  } catch (err) {
    console.error('[flow-api/project-benefits] get failed:', err);
    return error.internal(c, 'Failed to fetch benefit');
  }
});

app.get('/:id/measurements', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findBenefit(db, id);
    if (!row) return error.notFound(c, BENEFIT_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);
    const rows = await measurementsOf(db, id);
    return list(c, rows.map(presentMeasurement), cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[flow-api/project-benefits] measurements failed:', err);
    return error.internal(c, 'Failed to list measurements');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createBenefitSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canWriteProject(c, input.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (!(await liveProjectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  const metric = input.metric ?? 'manual';
  const params = metricParamsError(metric, input.metricParams ?? {});
  if (!params.ok) return error.badRequest(c, params.message);

  try {
    const now = new Date();
    const id = generateId('ben');
    const number = await allocateNumber(db, benefitSequence(input.projectId));
    const unit = input.unit ?? (isMetric(metric) ? METRIC_CATALOGUE[metric].unit : null);
    const values = newBenefitValues(
      {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        ownerId: input.ownerId,
        goalRef: input.goalRef,
        metric,
        metricParams: params.params,
        unit,
        baselineValue: numeric(input.baselineValue),
        targetValue: numeric(input.targetValue),
        realiseBy: toDate(input.realiseBy),
        status: input.status ?? 'planned',
      },
      { id, number, userId, now },
    );
    await atomically(db, (handle) => [handle.insert(t).values(values)]);
    const row = await findBenefit(db, id);
    if (!row) return error.internal(c, 'Failed to create benefit');

    if (metricIsMeasured(row.metric)) markBenefitMeasureDue(c, now);
    publishBenefit(c, 'created', row);
    return success(c, presentBenefit(row, null), 201);
  } catch (err) {
    console.error('[flow-api/project-benefits] create failed:', err);
    return error.internal(c, 'Failed to create benefit');
  }
});

// ── Edit ────────────────────────────────────────────────────────────────────

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findBenefit(db, id);
  if (!existing) return error.notFound(c, BENEFIT_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, updateBenefitSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  // A new metric starts with the parameters sent with it (none: empty); an edit of the parameters alone keeps the metric.
  const metricChanged = input.metric !== undefined && input.metric !== existing.metric;
  const nextMetric = input.metric ?? existing.metric;
  let nextParams: Record<string, unknown> | undefined;
  if (input.metric !== undefined || input.metricParams !== undefined) {
    const checked = metricParamsError(nextMetric, input.metricParams ?? (metricChanged ? {} : existing.metricParams));
    if (!checked.ok) return error.badRequest(c, checked.message);
    nextParams = checked.params;
  }

  try {
    const now = new Date();
    const set: Partial<typeof t.$inferInsert> = { updatedAt: now };
    if (input.title !== undefined) set.title = input.title;
    if (input.description !== undefined) set.description = input.description;
    if (input.ownerId !== undefined) set.ownerId = input.ownerId;
    if (input.goalRef !== undefined) set.goalRef = input.goalRef;
    if (input.metric !== undefined) set.metric = input.metric;
    if (nextParams !== undefined) set.metricParams = nextParams;
    if (input.unit !== undefined) set.unit = input.unit;
    if (input.baselineValue !== undefined) set.baselineValue = numeric(input.baselineValue);
    if (input.targetValue !== undefined) set.targetValue = numeric(input.targetValue);
    if (input.realiseBy !== undefined) set.realiseBy = toDate(input.realiseBy);
    if (input.status !== undefined) {
      set.status = input.status;
      set.closedAt = benefitClosedAtFor(input.status, existing.closedAt, now);
    }

    await atomically(db, (handle) => [handle.update(t).set(set).where(and(eq(t.id, id), isNull(t.deletedAt)))]);
    const row = await findBenefit(db, id);
    if (!row) return error.notFound(c, BENEFIT_LABEL, id);

    // Editing a benefit that is measured (or has just become so) has the sweep look at it next month.
    if (metricIsMeasured(row.metric) && row.closedAt === null) markBenefitMeasureDue(c, now);
    publishBenefit(c, 'updated', row);
    if (existing.status !== 'realised' && row.status === 'realised') publishBenefit(c, 'realised', row);
    return success(c, await presentBenefitRow(db, row));
  } catch (err) {
    console.error('[flow-api/project-benefits] update failed:', err);
    return error.internal(c, 'Failed to update benefit');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findBenefit(db, id);
    if (!existing) return error.notFound(c, BENEFIT_LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);

    const linkRows = await linksOfObject(db, 'benefit', id);
    const now = new Date();
    // The benefit's links go with it, in the same batch; its measurements stay (append-only).
    await atomically(db, (handle) => [
      handle.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt))),
      handle
        .delete(linksTable)
        .where(
          or(
            and(eq(linksTable.fromType, 'benefit'), eq(linksTable.fromId, id)),
            and(eq(linksTable.toType, 'benefit'), eq(linksTable.toId, id)),
          ),
        ),
    ]);
    publishEntityEvent({
      c,
      entityType: 'project_benefit',
      entityId: id,
      action: 'deleted',
      data: { id, projectId: existing.projectId, code: benefitCode(existing.number) },
    });
    for (const link of linkRows) {
      publishEntityEvent({
        c,
        entityType: 'project_control_link',
        entityId: link.id,
        action: 'deleted',
        data: controlLinkEventData(link),
      });
    }
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-benefits] delete failed:', err);
    return error.internal(c, 'Failed to delete benefit');
  }
});

// ── Manual measurement ──────────────────────────────────────────────────────

app.post('/:id/measurements', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findBenefit(db, id);
  if (!existing) return error.notFound(c, BENEFIT_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, createMeasurementSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const now = new Date();
  if (isFuturePeriod(input.period, now)) return error.badRequest(c, BENEFIT_MESSAGES.futurePeriod);

  try {
    await upsertMeasurement(db, {
      benefitId: id,
      projectId: existing.projectId,
      period: input.period,
      value: String(input.value),
      measuredBy: userId,
      now,
    });
    const [row, measurementRows] = await Promise.all([findBenefit(db, id), measurementsOf(db, id)]);
    const measurement = measurementRows.find((m) => m.period === input.period);
    if (!row || !measurement) return error.internal(c, 'Failed to store measurement');

    publishBenefit(c, 'updated', row, { period: measurement.period, value: measurement.value });
    return success(c, { measurement: presentMeasurement(measurement), benefit: presentBenefit(row, latestOf(measurementRows)) }, 201);
  } catch (err) {
    console.error('[flow-api/project-benefits] measurement failed:', err);
    return error.internal(c, 'Failed to store measurement');
  }
});

export const projectBenefitsRoutes = app;
