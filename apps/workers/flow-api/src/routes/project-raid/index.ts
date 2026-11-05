/**
 * RAID log routes: /api/project-raid/*, backed by `project_raid_items` and
 * `project_raid_assessments` (design: weldflow-project-control.md; ADRs
 * FLOW-010 and FLOW-011).
 *
 *   GET    /                list (projectId optional, filters, cursor)
 *   GET    /matrix          5x5 counts of open risks
 *   GET    /categories      the workspace's risk categories (built-ins, hidden flags, custom ones)
 *   PUT    /categories      replace them (portfolio:manage); a rename moves the items that carry the old name
 *   GET    /:id             item, assessments (newest first), links, task progress
 *   POST   /                create (kind picks the fields)
 *   PATCH  /:id             edit
 *   DELETE /:id             soft delete, with the item's links
 *   POST   /:id/assess      reassess a risk: item + assessment + next review, one batch
 *   POST   /:id/convert     assumption -> risk, risk -> issue
 *   POST   /:id/tasks       create a mitigation (risk) or resolution (issue) task
 *   POST   /:id/request-acceptance  ask the sponsor to accept a risk (strategy accept, score 9 or more)
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete,
 * plus the project membership boundary (FLOW-001). The checks run in a fixed
 * order so every backend answers alike: permission, then the item (404), then
 * project access (403), then the body (400), then the business rules.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  RAID_KINDS,
  RISK_BANDS,
  assessRiskSchema,
  convertRaidItemSchema,
  createRaidItemSchema,
  createRaidTaskSchema,
  updateRaidItemSchemas,
  updateRiskCategoriesSchema,
  type CreateRaidItemInput,
  type RaidKind,
  type UpdateIssueInput,
  type UpdateRaidItemInput,
  type UpdateRiskInput,
} from '@weldsuite/app-api-client/schemas/project-control';
import {
  closedAtFor,
  conversionError,
  conversionInputError,
  controlLinkEventData,
  presentControlLink,
  presentRaidAssessment,
  presentRaidItem,
  raidCode,
  raidEventData,
  raidFieldsError,
  raidSequence,
  sourceStatusAfterConversion,
} from '@weldsuite/flow-domain/raid';
import {
  RISK_BAND_RANGES,
  buildRiskMatrix,
  movedIntoCritical,
  nextReviewAt,
  residualPairError,
  riskBand,
  riskScore,
} from '@weldsuite/flow-domain/risk';
import { planRiskCategories, presentRiskCategories } from '@weldsuite/flow-domain/risk-categories';
import { DEFAULT_SCORING_MODEL } from '@weldsuite/flow-domain/intake';
import { requestRiskAcceptanceSchema } from '@weldsuite/app-api-client/schemas/flow-approvals';
import { acceptanceError } from '@weldsuite/flow-domain/acceptance';
import { presentReviewApprover } from '@weldsuite/flow-domain/approval-views';
import { cancelPendingApprovals } from '@weldsuite/flow-domain/approvals';
import { allocateNumber } from '@weldsuite/flow-domain/task-numbering';
import { createTask } from '@weldsuite/flow-domain/tasks';
import type { Env, Variables } from '../../types';
import { accessibleProjectIds, canAccessProject, canWriteProject, inAccessibleProjects } from '../../lib/project-access';
import { containsPattern, parseLimit, queryBoolean } from '../../lib/query-params';
import { taskAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { dispatchAssignmentNotifications } from '../../lib/task-notifications';
import { announceApprovalsCancelled } from '../../services/approvals';
import { requestRiskAcceptance } from '../../services/risk-acceptance';
import {
  convertedItemValues,
  findRaidItem,
  linksOfRaidItem,
  liveProjectExists,
  money,
  newRaidItemValues,
  presentLinkedObjects,
  taskProgressFor,
  toDate,
  type NewRaidItemRow,
  type RaidItemRow,
} from '../../services/project-raid';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectRaidItems;
const assessments = schema.projectRaidAssessments;
const linksTable = schema.projectControlLinks;
const settingsTable = schema.flowWorkspaceSettings;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
const ITEM_LABEL = 'RAID item';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// ── Request helpers ─────────────────────────────────────────────────────────

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** The JSON body parsed with a Zod schema: a 400 with the issues otherwise. */
async function parseBody<S extends z.ZodTypeAny>(c: AppContext, bodySchema: S): Promise<Parsed<z.infer<S>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: error.badRequest(c, 'Invalid JSON body') };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid request body', details) };
  }
  return { ok: true, data: parsed.data };
}

const listQuerySchema = z.object({
  projectId: z.string().optional(),
  kind: z.enum(RAID_KINDS).optional(),
  status: z.string().optional(),
  ownerId: z.string().optional(),
  band: z.enum(RISK_BANDS).optional(),
  open: queryBoolean.optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

const matrixQuerySchema = z.object({
  projectId: z.string().optional(),
  residual: queryBoolean.optional(),
});

/** The query string without empty values (`?projectId=` means no filter). */
function readQuery<S extends z.ZodTypeAny>(c: AppContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', details) };
  }
  return { ok: true, data: parsed.data };
}

/** Project scope of a list: the one project (when the caller is in it) or every accessible project. Null when off-limits. */
async function projectScope(c: AppContext, projectId: string | undefined): Promise<SQL[] | null> {
  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (projectId) {
    if (!(await canAccessProject(c, projectId))) return null;
    conditions.push(eq(t.projectId, projectId));
  } else {
    conditions.push(inAccessibleProjects(t.projectId, await accessibleProjectIds(c)));
  }
  return conditions;
}

// ── Events ──────────────────────────────────────────────────────────────────

type RaidAction = 'created' | 'updated' | 'escalated' | 'converted' | 'closed';

function publishRaid(c: AppContext, action: RaidAction, row: RaidItemRow, extra: Record<string, unknown> = {}) {
  publishEntityEvent({
    c,
    entityType: 'project_raid_item',
    entityId: row.id,
    action,
    data: { ...raidEventData(row), ...extra },
  });
}

function publishLink(c: AppContext, action: 'created' | 'deleted', row: typeof linksTable.$inferSelect) {
  publishEntityEvent({
    c,
    entityType: 'project_control_link',
    entityId: row.id,
    action,
    data: controlLinkEventData(row),
  });
}

/** The row's score, null unless it is a risk. */
function scoreOf(row: Pick<RaidItemRow, 'kind' | 'probability' | 'impact'>): number | null {
  return row.kind === 'risk' && row.probability !== null && row.impact !== null
    ? riskScore(row.probability, row.impact)
    : null;
}

/** A project another project's dependency points at must exist and be one the caller is in. */
async function partyProjectError(c: AppContext, partyProjectId: string | null | undefined): Promise<Response | null> {
  if (!partyProjectId) return null;
  if (!(await liveProjectExists(c.get('tenantDb'), partyProjectId))) {
    return error.badRequest(c, 'Party project not found');
  }
  if (!(await canAccessProject(c, partyProjectId))) return error.forbidden(c, PROJECT_DENIED);
  return null;
}

/** The register item as every route answers it, with its task progress. */
async function presentOne(c: AppContext, row: RaidItemRow) {
  const progress = await taskProgressFor(c.get('tenantDb'), [row.id]);
  return presentRaidItem(row, progress.get(row.id) ?? { done: 0, total: 0 });
}

/** The fields every kind copies from a validated body, when the body has them. */
const COMMON_UPDATE_FIELDS = ['title', 'description', 'category', 'ownerId', 'customFields'] as const satisfies readonly (keyof NewRaidItemRow)[];

/** The fields of each kind copied as they are; dates, money and the status are converted in `updateValues`. */
const KIND_UPDATE_FIELDS = {
  risk: ['probability', 'impact', 'residualProbability', 'residualImpact', 'strategy', 'trigger', 'scheduleImpactDays', 'reviewIntervalDays'],
  assumption: ['confidence', 'ifWrong'],
  issue: ['severity'],
  dependency: ['direction', 'partyType', 'partyProjectId', 'partyName'],
} as const satisfies Record<RaidKind, readonly (keyof NewRaidItemRow)[]>;

/** The columns an edit writes, from the body validated for the item's kind. */
function updateValues(existing: RaidItemRow, data: UpdateRaidItemInput, now: Date): Partial<NewRaidItemRow> {
  const body = data as Record<string, unknown>;
  const set: Partial<NewRaidItemRow> = { updatedAt: now };
  const copy: Record<string, unknown> = set;
  for (const field of [...COMMON_UPDATE_FIELDS, ...KIND_UPDATE_FIELDS[existing.kind]]) {
    if (body[field] !== undefined) copy[field] = body[field];
  }
  if (data.dueAt !== undefined) set.dueAt = toDate(data.dueAt);
  if (data.status !== undefined) {
    set.status = data.status;
    set.closedAt = closedAtFor(existing.kind, data.status, existing.closedAt, now);
  }
  const { costImpact } = data as UpdateRiskInput;
  if (existing.kind === 'risk' && costImpact !== undefined) set.costImpact = money(costImpact);
  const { escalatedAt } = data as UpdateIssueInput;
  if (existing.kind === 'issue' && escalatedAt !== undefined) set.escalatedAt = toDate(escalatedAt);
  return set;
}

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 25, 100);

  const conditions = await projectScope(c, q.projectId);
  if (!conditions) return error.forbidden(c, PROJECT_DENIED);
  if (q.kind) conditions.push(eq(t.kind, q.kind));
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.ownerId) conditions.push(eq(t.ownerId, q.ownerId));
  if (q.band) {
    const range = RISK_BAND_RANGES[q.band];
    conditions.push(and(isNotNull(t.score), gte(t.score, range.min), lte(t.score, range.max)) as SQL);
  }
  // Open means not yet in a closed status, which is exactly `closed_at IS NULL`.
  if (q.open) conditions.push(isNull(t.closedAt));
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
    const progress = await taskProgressFor(db, data.map((row) => row.id));
    return list(
      c,
      data.map((row) => presentRaidItem(row, progress.get(row.id) ?? { done: 0, total: 0 })),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/project-raid] list failed:', err);
    return error.internal(c, 'Failed to list RAID items');
  }
});

// MUST be before /:id.
app.get('/matrix', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, matrixQuerySchema);
  if (!query.ok) return query.response;
  const residual = query.data.residual ?? false;

  const conditions = await projectScope(c, query.data.projectId);
  if (!conditions) return error.forbidden(c, PROJECT_DENIED);
  conditions.push(eq(t.kind, 'risk'), isNull(t.closedAt));

  // After mitigation, a risk with no residual assessment stays in its current cell.
  const probability = residual ? sql`coalesce(${t.residualProbability}, ${t.probability})` : sql`${t.probability}`;
  const impact = residual ? sql`coalesce(${t.residualImpact}, ${t.impact})` : sql`${t.impact}`;
  try {
    const counts = await db
      .select({
        probability: probability.mapWith(Number),
        impact: impact.mapWith(Number),
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(t)
      .where(and(...conditions))
      .groupBy(probability, impact);
    const total = counts.reduce((sum, cell) => sum + cell.count, 0);
    return success(c, { residual, total, cells: buildRiskMatrix(counts) });
  } catch (err) {
    console.error('[flow-api/project-raid] matrix failed:', err);
    return error.internal(c, 'Failed to load the risk matrix');
  }
});

// ── Risk categories ─────────────────────────────────────────────────────────

/** The stored risk categories of the workspace, null before the first save. */
async function storedRiskCategories(db: Database) {
  const [row] = await db.select({ riskCategories: settingsTable.riskCategories }).from(settingsTable).limit(1);
  return row?.riskCategories ?? null;
}

// MUST be before /:id.
app.get('/categories', requirePermission('projects:read'), async (c) => {
  try {
    return success(c, presentRiskCategories(await storedRiskCategories(c.get('tenantDb'))));
  } catch (err) {
    console.error('[flow-api/project-raid] get categories failed:', err);
    return error.internal(c, 'Failed to fetch risk categories');
  }
});

/**
 * Replace the workspace's risk categories. Workspace-level, so it takes
 * `portfolio:manage`, not project membership. A rename moves every RAID item
 * (any project, any kind) that carries the old name to the new one, in the
 * same batch as the settings row.
 */
app.put('/categories', requirePermission('portfolio:manage'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, updateRiskCategoriesSchema);
  if (!body.ok) return body.response;

  try {
    const plan = planRiskCategories(await storedRiskCategories(db), body.data, () => generateId('rcat'));
    if (!plan.ok) return error.badRequest(c, plan.message);

    const now = new Date();
    const renamed = plan.renames.length === 0
      ? []
      : await db
          .select({ id: t.id })
          .from(t)
          .where(and(inArray(t.category, plan.renames.map((r) => r.from)), isNull(t.deletedAt)))
          .orderBy(asc(t.id));
    // One statement for every rename, so swapping two names does not merge them.
    const renamedCategory = sql`case ${t.category} ${sql.join(
      plan.renames.map((r) => sql`when ${r.from} then ${r.to}`),
      sql` `,
    )} else ${t.category} end`;

    await atomically(db, (handle) => [
      handle
        .insert(settingsTable)
        .values({
          id: generateId('fws'),
          singleton: true,
          scoringModel: [...DEFAULT_SCORING_MODEL],
          portfolioBoardIds: [],
          riskCategories: plan.next,
          updatedBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settingsTable.singleton,
          set: { riskCategories: plan.next, updatedBy: userId, updatedAt: now },
        }),
      ...(renamed.length === 0
        ? []
        : [
            handle
              .update(t)
              .set({ category: renamedCategory, updatedAt: now })
              .where(inArray(t.id, renamed.map((r) => r.id))),
          ]),
    ]);

    const presented = presentRiskCategories(plan.next);
    const [settings] = await db.select({ id: settingsTable.id }).from(settingsTable).limit(1);
    if (settings) {
      publishEntityEvent({
        c,
        entityType: 'flow_workspace_settings',
        entityId: settings.id,
        action: 'updated',
        data: { id: settings.id, riskCategories: presented },
      });
    }
    if (renamed.length > 0) {
      const rows = await db
        .select()
        .from(t)
        .where(inArray(t.id, renamed.map((r) => r.id)))
        .orderBy(asc(t.id));
      for (const row of rows) publishRaid(c, 'updated', row);
    }
    return success(c, presented);
  } catch (err) {
    console.error('[flow-api/project-raid] save categories failed:', err);
    return error.internal(c, 'Failed to save risk categories');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findRaidItem(db, id);
    if (!row) return error.notFound(c, ITEM_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);

    const [assessmentRows, linkRows, progress] = await Promise.all([
      db
        .select()
        .from(assessments)
        .where(eq(assessments.itemId, id))
        .orderBy(desc(assessments.assessedAt), desc(assessments.id)),
      linksOfRaidItem(db, id),
      taskProgressFor(db, [id]),
    ]);
    const links = await presentLinkedObjects(
      db,
      linkRows,
      (link) => (link.fromType === 'raid_item' && link.fromId === id ? 'outgoing' : 'incoming'),
      (projectId) => canAccessProject(c, projectId),
    );
    return success(c, {
      ...presentRaidItem(row, progress.get(id) ?? { done: 0, total: 0 }),
      assessments: assessmentRows.map(presentRaidAssessment),
      links,
    });
  } catch (err) {
    console.error('[flow-api/project-raid] get failed:', err);
    return error.internal(c, 'Failed to fetch RAID item');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createRaidItemSchema);
  if (!body.ok) return body.response;
  const input: CreateRaidItemInput = body.data;

  if (!(await canWriteProject(c, input.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (!(await liveProjectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const fieldError = raidFieldsError(input.kind, input.projectId, {
    residualProbability: input.kind === 'risk' ? input.residualProbability : undefined,
    residualImpact: input.kind === 'risk' ? input.residualImpact : undefined,
    partyType: input.kind === 'dependency' ? input.partyType : undefined,
    partyProjectId: input.kind === 'dependency' ? input.partyProjectId : undefined,
  });
  if (fieldError) return error.badRequest(c, fieldError);
  if (input.kind === 'dependency') {
    const denied = await partyProjectError(c, input.partyProjectId);
    if (denied) return denied;
  }

  try {
    const now = new Date();
    const id = generateId('raid');
    const number = await allocateNumber(db, raidSequence(input.kind, input.projectId));
    const values = newRaidItemValues(input, { id, number, userId, now });
    await atomically(db, (handle) => [
      handle.insert(t).values(values),
      // A risk's first assessment is its creation: the start of the trend.
      ...(input.kind === 'risk'
        ? [
            handle.insert(assessments).values({
              id: generateId('rasm'),
              itemId: id,
              projectId: input.projectId,
              probability: input.probability,
              impact: input.impact,
              residualProbability: input.residualProbability ?? null,
              residualImpact: input.residualImpact ?? null,
              note: null,
              assessedBy: userId,
              assessedAt: now,
            }),
          ]
        : []),
    ]);
    const row = await findRaidItem(db, id);
    if (!row) return error.internal(c, 'Failed to create RAID item');

    publishRaid(c, 'created', row);
    if (row.closedAt) publishRaid(c, 'closed', row);
    return success(c, presentRaidItem(row, { done: 0, total: 0 }), 201);
  } catch (err) {
    console.error('[flow-api/project-raid] create failed:', err);
    return error.internal(c, 'Failed to create RAID item');
  }
});

// ── Edit ────────────────────────────────────────────────────────────────────

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findRaidItem(db, id);
  if (!existing) return error.notFound(c, ITEM_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, updateRaidItemSchemas[existing.kind]);
  if (!body.ok) return body.response;

  try {
    const now = new Date();
    const set = updateValues(existing, body.data as UpdateRaidItemInput, now);
    const next = { ...existing, ...set } as RaidItemRow;
    const fieldError = raidFieldsError(next.kind, next.projectId, next);
    if (fieldError) return error.badRequest(c, fieldError);
    if (next.kind === 'dependency' && next.partyProjectId !== existing.partyProjectId) {
      const denied = await partyProjectError(c, next.partyProjectId);
      if (denied) return denied;
    }

    // Changing probability or impact is a reassessment: it enters the trend.
    const previousScore = scoreOf(existing);
    const nextScore = scoreOf(next);
    const rated = previousScore !== null && nextScore !== null && (next.probability !== existing.probability || next.impact !== existing.impact);
    await atomically(db, (handle) => [
      handle.update(t).set(set).where(and(eq(t.id, id), isNull(t.deletedAt))),
      ...(rated && next.probability !== null && next.impact !== null
        ? [
            handle.insert(assessments).values({
              id: generateId('rasm'),
              itemId: id,
              projectId: existing.projectId,
              probability: next.probability,
              impact: next.impact,
              residualProbability: next.residualProbability,
              residualImpact: next.residualImpact,
              note: null,
              assessedBy: userId,
              assessedAt: now,
            }),
          ]
        : []),
    ]);
    const row = await findRaidItem(db, id);
    if (!row) return error.notFound(c, ITEM_LABEL, id);

    publishRaid(c, 'updated', row);
    if (rated && previousScore !== null && nextScore !== null && movedIntoCritical(previousScore, nextScore)) {
      publishRaid(c, 'escalated', row, { previousScore, previousBand: riskBand(previousScore) });
    }
    if (existing.closedAt === null && row.closedAt !== null) publishRaid(c, 'closed', row);
    return success(c, await presentOne(c, row));
  } catch (err) {
    console.error('[flow-api/project-raid] update failed:', err);
    return error.internal(c, 'Failed to update RAID item');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findRaidItem(db, id);
    if (!existing) return error.notFound(c, ITEM_LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);

    // The item's links go with it, in the same batch.
    const linkRows = await linksOfRaidItem(db, id);
    const now = new Date();
    await atomically(db, (handle) => [
      handle.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt))),
      handle
        .delete(linksTable)
        .where(
          or(
            and(eq(linksTable.fromType, 'raid_item'), eq(linksTable.fromId, id)),
            and(eq(linksTable.toType, 'raid_item'), eq(linksTable.toId, id)),
          ),
        ),
    ]);
    // A risk that is gone has nothing left to accept: close the open acceptance request.
    if (existing.kind === 'risk') {
      announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'risk_acceptance', subjectId: id, includeDecided: true }));
    }
    publishEntityEvent({
      c,
      entityType: 'project_raid_item',
      entityId: id,
      action: 'deleted',
      data: { id, projectId: existing.projectId, kind: existing.kind, code: raidCode(existing.kind, existing.number) },
    });
    for (const link of linkRows) publishLink(c, 'deleted', link);
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-raid] delete failed:', err);
    return error.internal(c, 'Failed to delete RAID item');
  }
});

// ── Assess ──────────────────────────────────────────────────────────────────

app.post('/:id/assess', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findRaidItem(db, id);
  if (!existing) return error.notFound(c, ITEM_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, assessRiskSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (existing.kind !== 'risk') return error.badRequest(c, 'Only risks can be assessed');

  const residualProbability = input.residualProbability !== undefined ? input.residualProbability : existing.residualProbability;
  const residualImpact = input.residualImpact !== undefined ? input.residualImpact : existing.residualImpact;
  const pairError = residualPairError(residualProbability, residualImpact);
  if (pairError) return error.badRequest(c, pairError);

  try {
    const now = new Date();
    const previousScore = scoreOf(existing);
    const score = riskScore(input.probability, input.impact);
    // The next review: the one given, else now plus the interval of the new band.
    const dueAt = toDate(input.nextReviewAt) ?? nextReviewAt(now, riskBand(score), existing.reviewIntervalDays);
    const assessmentId = generateId('rasm');
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({
          probability: input.probability,
          impact: input.impact,
          residualProbability,
          residualImpact,
          dueAt,
          updatedAt: now,
        })
        .where(and(eq(t.id, id), isNull(t.deletedAt))),
      handle.insert(assessments).values({
        id: assessmentId,
        itemId: id,
        projectId: existing.projectId,
        probability: input.probability,
        impact: input.impact,
        residualProbability,
        residualImpact,
        note: input.note ?? null,
        assessedBy: userId,
        assessedAt: now,
      }),
    ]);
    const row = await findRaidItem(db, id);
    const [assessment] = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
    if (!row || !assessment) return error.internal(c, 'Failed to assess risk');

    publishRaid(c, 'updated', row);
    if (previousScore !== null && movedIntoCritical(previousScore, score)) {
      publishRaid(c, 'escalated', row, { previousScore, previousBand: riskBand(previousScore) });
    }
    return success(c, { item: await presentOne(c, row), assessment: presentRaidAssessment(assessment) });
  } catch (err) {
    console.error('[flow-api/project-raid] assess failed:', err);
    return error.internal(c, 'Failed to assess risk');
  }
});

// ── Convert ─────────────────────────────────────────────────────────────────

app.post('/:id/convert', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const source = await findRaidItem(db, id);
  if (!source) return error.notFound(c, ITEM_LABEL, id);
  if (!(await canWriteProject(c, source.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, convertRaidItemSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const notConvertible = conversionError(source.kind, input.to);
  if (notConvertible) return error.badRequest(c, notConvertible);
  if (source.closedAt !== null) return error.conflict(c, 'This item is already closed');
  const wrongFields = conversionInputError(input.to, input);
  if (wrongFields) return error.badRequest(c, wrongFields);

  try {
    const now = new Date();
    const newId = generateId('raid');
    const number = await allocateNumber(db, raidSequence(input.to, source.projectId));
    const created = convertedItemValues(source, input, { id: newId, number, userId, now });
    const riskRating =
      created.kind === 'risk' && typeof created.probability === 'number' && typeof created.impact === 'number'
        ? { probability: created.probability, impact: created.impact }
        : null;
    const linkId = generateId('pcl');
    await atomically(db, (handle) => [
      handle.insert(t).values(created),
      ...(riskRating
        ? [
            handle.insert(assessments).values({
              id: generateId('rasm'),
              itemId: newId,
              projectId: source.projectId,
              probability: riskRating.probability,
              impact: riskRating.impact,
              residualProbability: null,
              residualImpact: null,
              note: null,
              assessedBy: userId,
              assessedAt: now,
            }),
          ]
        : []),
      handle.insert(linksTable).values({
        id: linkId,
        projectId: source.projectId,
        fromType: 'raid_item',
        fromId: newId,
        toType: 'raid_item',
        toId: id,
        relation: 'raised_from',
        createdBy: userId,
        createdAt: now,
      }),
      handle
        .update(t)
        .set({ status: sourceStatusAfterConversion(source.kind), closedAt: now, updatedAt: now })
        .where(and(eq(t.id, id), isNull(t.deletedAt))),
    ]);
    // The source is closed now: a risk converted to an issue is no longer accepted or refused as a risk.
    if (source.kind === 'risk') {
      announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'risk_acceptance', subjectId: id, includeDecided: true }));
    }
    const [newRow, sourceRow] = await Promise.all([findRaidItem(db, newId), findRaidItem(db, id)]);
    const [linkRow] = await db.select().from(linksTable).where(eq(linksTable.id, linkId)).limit(1);
    if (!newRow || !sourceRow || !linkRow) return error.internal(c, 'Failed to convert RAID item');

    publishRaid(c, 'created', newRow);
    publishRaid(c, 'converted', sourceRow, { to: input.to, newItemId: newRow.id, newCode: raidCode(newRow.kind, newRow.number) });
    publishRaid(c, 'closed', sourceRow);
    publishLink(c, 'created', linkRow);
    return success(
      c,
      { item: await presentOne(c, newRow), source: await presentOne(c, sourceRow), link: presentControlLink(linkRow) },
      201,
    );
  } catch (err) {
    console.error('[flow-api/project-raid] convert failed:', err);
    return error.internal(c, 'Failed to convert RAID item');
  }
});

// ── Mitigation and resolution tasks ─────────────────────────────────────────

app.post('/:id/tasks', requirePermission('projects:update'), requirePermission('tasks:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const item = await findRaidItem(db, id);
  if (!item) return error.notFound(c, ITEM_LABEL, id);
  if (!(await canWriteProject(c, item.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, createRaidTaskSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (item.kind !== 'risk' && item.kind !== 'issue') {
    return error.badRequest(c, 'Only risks and issues can have mitigation or resolution tasks');
  }

  let taskId: string | null = null;
  try {
    // The ordinary task path: number, position and stage rules are the task routes'.
    const { row, assigneeIds } = await createTask(
      db,
      {
        title: input.title,
        description: input.description ?? undefined,
        assigneeId: input.assigneeId ?? undefined,
        dueDate: input.dueDate ?? undefined,
        priority: input.priority,
      },
      { projectId: item.projectId, userId },
    );
    taskId = row.id;

    const now = new Date();
    const linkRow: typeof linksTable.$inferSelect = {
      id: generateId('pcl'),
      projectId: item.projectId,
      fromType: 'task',
      fromId: row.id,
      toType: 'raid_item',
      toId: id,
      relation: item.kind === 'risk' ? 'mitigates' : 'resolves',
      createdBy: userId,
      createdAt: now,
    };
    // Task creation is several statements, so it cannot share a batch with the
    // link; if the link fails the task is taken back out below.
    await atomically(db, (handle) => [handle.insert(linksTable).values(linkRow)]);

    publishEntityEvent({
      c,
      entityType: 'project_task',
      entityId: row.id,
      action: 'created',
      data: taskAnalyticsPayload(row as Record<string, unknown>, { projectId: item.projectId }),
    });
    publishLink(c, 'created', linkRow);
    dispatchAssignmentNotifications(c, {
      assigneeIds,
      taskId: row.id,
      taskTitle: row.title,
      projectId: item.projectId,
      taskPriority: row.priority ?? null,
      dueDate: row.dueDate ?? null,
      taskDescription: row.description ?? null,
    });

    const progress = await taskProgressFor(db, [id]);
    return success(
      c,
      {
        task: {
          id: row.id,
          number: row.number ?? null,
          projectId: row.projectId ?? null,
          title: row.title,
          status: row.status,
          priority: row.priority,
          assigneeId: row.assigneeId ?? null,
          dueDate: row.dueDate ? new Date(row.dueDate).toISOString() : null,
        },
        link: presentControlLink(linkRow),
        taskProgress: progress.get(id) ?? { done: 0, total: 0 },
      },
      201,
    );
  } catch (err) {
    console.error('[flow-api/project-raid] create task failed:', err);
    if (taskId) {
      const taken = new Date();
      await db
        .update(schema.tasks)
        .set({ deletedAt: taken, updatedAt: taken })
        .where(eq(schema.tasks.id, taskId))
        .catch((undoErr: unknown) => console.error('[flow-api/project-raid] task rollback failed:', undoErr));
    }
    return error.internal(c, 'Failed to create task');
  }
});

// ── Risk acceptance (FLOW-016) ──────────────────────────────────────────────

app.post('/:id/request-acceptance', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const item = await findRaidItem(db, id);
  if (!item) return error.notFound(c, ITEM_LABEL, id);
  if (!(await canWriteProject(c, item.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, requestRiskAcceptanceSchema);
  if (!body.ok) return body.response;
  const refusal = acceptanceError(item);
  if (refusal) return refusal.status === 409 ? error.conflict(c, refusal.message) : error.badRequest(c, refusal.message);

  try {
    const result = await requestRiskAcceptance(c, db, item, body.data.note ?? null);
    if (!result.ok) return result.status === 409 ? error.conflict(c, result.message) : error.badRequest(c, result.message);
    return success(c, { item: await presentOne(c, item), approvers: result.rows.map(presentReviewApprover) }, 201);
  } catch (err) {
    console.error('[flow-api/project-raid] request acceptance failed:', err);
    return error.internal(c, 'Failed to ask for acceptance');
  }
});

export const projectRaidRoutes = app;
