/**
 * Opportunities routes — flat /api/opportunities/* surface backed by `crm_opportunities`.
 *
 * Permissions: opportunities:read | opportunities:create | opportunities:update | opportunities:delete.
 *   opportunities:scope:all elevates from own-only default to cross-owner access.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  hasContextPermission,
  requirePermission,
} from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createOpportunitySchema,
  updateOpportunitySchema,
} from '@weldsuite/core-api-client/schemas/opportunities';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
} from '@weldsuite/core-domain/custom-field-values';
import { schema } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmOpportunities;

const NUMERIC_FIELDS = new Set(['amount', 'expectedRevenue', 'recurringRevenue']);
const DATE_FIELDS = new Set(['closeDate', 'startDate', 'nextStepDate']);

async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  if (await hasContextPermission(c, 'opportunities:scope:all')) return undefined;
  return c.get('userId');
}

/**
 * `customerName` is a denormalized mirror of the company's name, kept so
 * list/search views don't need a join. The create route never populated it
 * (the create schema doesn't even accept it), so the deal panel's Company
 * tab rendered "(unknown company)" for every new deal. Look the name up by
 * `customerId` so writers don't have to carry it themselves.
 */
async function lookupCompanyName(
  db: Variables['tenantDb'],
  customerId: string | undefined,
): Promise<string | undefined> {
  if (!customerId) return undefined;
  const [row] = await db
    .select({ name: schema.companies.name })
    .from(schema.companies)
    .where(and(eq(schema.companies.id, customerId), isNull(schema.companies.deletedAt)))
    .limit(1);
  return row?.name;
}

/** WHERE conditions for the list endpoint's query-string filters (no cursor). */
function buildListFilters(q: Record<string, string>, scope: string | undefined): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  const equalityFilters: Array<[string | undefined, AnyPgColumn]> = [
    [q.status, t.status],
    [q.stage, t.stage],
    [q.pipeline, t.pipeline],
    [q.ownerId, t.ownerId],
    [q.customerId, t.customerId],
  ];
  for (const [value, column] of equalityFilters) {
    if (value) conditions.push(eq(column, value));
  }
  // Filter by a linked Person — the `personIds` JSONB array stores the
  // canonical Person FKs; `contactIds` is the legacy back-reference and we
  // match against both for migration overlap.
  if (q.personId) {
    const personNeedle = JSON.stringify([q.personId]);
    conditions.push(
      sql`(${t.personIds} @> ${personNeedle}::jsonb OR ${t.contactIds} @> ${personNeedle}::jsonb)`,
    );
  }
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.customerName, term), like(t.description, term))!);
  }
  return conditions;
}

/** Keyset condition that resumes after the row identified by `cursorId`, if it exists. */
async function buildCursorCondition(
  db: Variables['tenantDb'],
  cursorId: string,
): Promise<SQL | undefined> {
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursorId)).limit(1);
  if (!cur?.createdAt) return undefined;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

app.get('/', requirePermission('opportunities:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);
  const scope = await scopeFor(c);

  const filterConditions = buildListFilters(q, scope);
  const cursorCondition = q.cursor ? await buildCursorCondition(db, q.cursor) : undefined;
  const where = and(...filterConditions, cursorCondition);

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    // Phase 3: customFields comes from the typed values table, not the blob.
    const hydrated = await hydrateCustomFields(db, 'opportunity', data);
    return list(c, hydrated, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/opportunities] list failed:', err);
    return error.internal(c, 'Failed to list opportunities');
  }
});

app.get('/:id', requirePermission('opportunities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [row] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!row) return error.notFound(c, 'Opportunity', id);
    // Phase 3: customFields comes from the typed values table, not the blob.
    return success(c, await hydrateCustomFieldsOne(db, 'opportunity', row));
  } catch (err) {
    console.error('[app-api/opportunities] get failed:', err);
    return error.internal(c, 'Failed to fetch opportunity');
  }
});

app.post('/', requirePermission('opportunities:create'), zValidator('json', createOpportunitySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const ownerId = data.ownerId ?? userId;
  if (!ownerId) return error.badRequest(c, 'ownerId required');
  const id = generateId('opp');
  const now = new Date();
  const closeDate = data.closeDate ? new Date(data.closeDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  try {
    const customerName = await lookupCompanyName(db, data.customerId);
    const values: typeof t.$inferInsert = {
      id,
      name: data.name,
      description: data.description,
      customerId: data.customerId,
      customerName,
      primaryContactId: data.primaryContactId,
      amount: data.amount !== undefined ? String(data.amount) : '0',
      currency: data.currency ?? 'EUR',
      expectedRevenue: data.expectedRevenue !== undefined ? String(data.expectedRevenue) : undefined,
      recurringRevenue: data.recurringRevenue !== undefined ? String(data.recurringRevenue) : undefined,
      contractLength: data.contractLength,
      stage: data.stage ?? 'prospecting',
      stageId: data.stageId,
      status: data.status ?? 'open',
      probability: data.probability ?? 0,
      pipeline: data.pipeline ?? 'default',
      closeDate,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      ownerId,
      teamMembers: data.teamMembers,
      leadSource: data.leadSource,
      campaign: data.campaign,
      type: data.type,
      category: data.category,
      nextStep: data.nextStep,
      nextStepDate: data.nextStepDate ? new Date(data.nextStepDate) : undefined,
      riskLevel: data.riskLevel,
      riskReason: data.riskReason,
      proposalUrl: data.proposalUrl,
      contractUrl: data.contractUrl,
      tags: data.tags,
      customFields: data.customFields as Record<string, unknown> | null | undefined,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(t).values(values);
    // Phase 1 dual-write: mirror the customFields blob into the typed values table.
    await syncValuesForEntity(db, 'opportunity', id, data.customFields as Record<string, unknown> | null | undefined);
    publishEntityEvent({
      c,
      entityType: 'opportunity',
      entityId: id,
      action: 'created',
      data: {
        id,
        name: values.name,
        amount: values.amount ?? '0',
        stage: values.stage ?? 'prospecting',
        status: values.status ?? 'open',
        currency: values.currency,
        customerId: values.customerId,
        pipelineId: values.pipeline,
        ownerId: values.ownerId,
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/opportunities] create failed:', err);
    return error.internal(c, 'Failed to create opportunity');
  }
});

/** Coerce one PATCH field to its column representation (numerics as strings, dates as Date). */
function toColumnValue(key: string, value: unknown): unknown {
  if (NUMERIC_FIELDS.has(key) && typeof value === 'number') return String(value);
  if (DATE_FIELDS.has(key) && typeof value === 'string') return new Date(value);
  return value;
}

/** Build the `set` payload for a PATCH, skipping undefined fields. */
function buildUpdatePayload(data: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) update[k] = toColumnValue(k, v);
  }
  return update;
}

type OpportunityRow = typeof t.$inferSelect;

/**
 * Publish the `updated` event plus the derived `stage_changed` / `won` / `lost`
 * events for a PATCH, comparing the new values against the pre-update row.
 */
function publishUpdateEvents(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  id: string,
  existing: OpportunityRow,
  update: Record<string, unknown>,
): void {
  const newStage = (update.stage as string | undefined) ?? existing.stage;
  const newStageId = (update.stageId as string | null | undefined) ?? existing.stageId;
  const newStatus = (update.status as string | undefined) ?? existing.status;
  const eventData = {
    id,
    name: (update.name as string | undefined) ?? existing.name,
    amount: (update.amount as string | undefined) ?? existing.amount ?? '0',
    stage: newStage,
    stageId: newStageId,
    status: newStatus,
    customerId: (update.customerId as string | null | undefined) ?? existing.customerId,
    ownerId: (update.ownerId as string | null | undefined) ?? existing.ownerId,
  };
  const publish = (action: 'updated' | 'stage_changed' | 'won' | 'lost') =>
    publishEntityEvent({ c, entityType: 'opportunity', entityId: id, action, data: eventData });

  publish('updated');
  if (newStage !== existing.stage || newStageId !== existing.stageId) publish('stage_changed');
  if (newStatus === 'won' && existing.status !== 'won') publish('won');
  else if (newStatus === 'lost' && existing.status !== 'lost') publish('lost');
}

type PipelineStageFlags = {
  id: string;
  isWon: boolean | null;
  isLost: boolean | null;
  probability: number | null;
};

async function loadStage(
  db: Variables['tenantDb'],
  stageId: string,
): Promise<PipelineStageFlags | undefined> {
  const [row] = await db
    .select({
      id: schema.crmPipelineStages.id,
      isWon: schema.crmPipelineStages.isWon,
      isLost: schema.crmPipelineStages.isLost,
      probability: schema.crmPipelineStages.probability,
    })
    .from(schema.crmPipelineStages)
    .where(and(eq(schema.crmPipelineStages.id, stageId), isNull(schema.crmPipelineStages.deletedAt)))
    .limit(1);
  return row;
}

/**
 * Keep `status` / `actualCloseDate` / `probability` in step with the stage a
 * deal sits in, in both directions (TASK-919):
 *  - Dragging the deal onto a stage flagged isWon/isLost (an explicit
 *    `stageId` in this PATCH) marks it won/lost, stamps `actualCloseDate`
 *    (today, unless already set) and copies the stage's probability. Moving
 *    it back out to a plain open stage reopens it and clears
 *    `actualCloseDate`.
 *  - Marking the deal won/lost directly (`status` in this PATCH, no
 *    `stageId`) moves it into the pipeline's matching isWon/isLost stage, if
 *    one exists, and stamps `actualCloseDate`. Reopening it directly clears
 *    `actualCloseDate`.
 * Mutates `update` in place; `targetStage` is the already-validated stage
 * for an explicit `stageId` move (avoids re-querying it).
 */
async function syncStatusWithStage(
  db: Variables['tenantDb'],
  existing: OpportunityRow,
  data: Record<string, unknown>,
  update: Record<string, unknown>,
  targetStage: PipelineStageFlags | undefined,
): Promise<void> {
  const explicitStatus = typeof data.status === 'string' ? data.status : undefined;

  if (targetStage) {
    if (targetStage.isWon || targetStage.isLost) {
      if (update.status === undefined) update.status = targetStage.isWon ? 'won' : 'lost';
      if (update.actualCloseDate === undefined && !existing.actualCloseDate) update.actualCloseDate = new Date();
      if (update.probability === undefined && targetStage.probability !== null) {
        update.probability = targetStage.probability;
      }
    } else {
      const previousStage = existing.stageId ? await loadStage(db, existing.stageId) : undefined;
      if (previousStage && (previousStage.isWon || previousStage.isLost) && update.status === undefined) {
        update.status = 'open';
        update.actualCloseDate = null;
      }
    }
    return;
  }

  if (!explicitStatus || explicitStatus === existing.status) return;

  if (explicitStatus === 'won' || explicitStatus === 'lost') {
    if (update.actualCloseDate === undefined && !existing.actualCloseDate) update.actualCloseDate = new Date();
    if (update.stageId === undefined) {
      const pipeline = (update.pipeline as string | undefined) ?? existing.pipeline ?? 'default';
      const flagColumn =
        explicitStatus === 'won' ? schema.crmPipelineStages.isWon : schema.crmPipelineStages.isLost;
      const [matchStage] = await db
        .select({ id: schema.crmPipelineStages.id, probability: schema.crmPipelineStages.probability })
        .from(schema.crmPipelineStages)
        .where(
          and(
            eq(schema.crmPipelineStages.pipeline, pipeline),
            eq(flagColumn, true),
            isNull(schema.crmPipelineStages.deletedAt),
          ),
        )
        .limit(1);
      if (matchStage) {
        update.stageId = matchStage.id;
        if (data.stage === undefined) update.stage = matchStage.id;
        if (update.probability === undefined && matchStage.probability !== null) {
          update.probability = matchStage.probability;
        }
      }
    }
  } else if (explicitStatus === 'open' || explicitStatus === 'abandoned') {
    if ((existing.status === 'won' || existing.status === 'lost') && update.actualCloseDate === undefined) {
      update.actualCloseDate = null;
    }
  }
}

app.patch('/:id', requirePermission('opportunities:update'), zValidator('json', updateOpportunitySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const scope = await scopeFor(c);
  const conditions: SQL[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Opportunity', id);
    const update = buildUpdatePayload(data);
    // `stageId` (a crm_pipeline_stages row) is what the board and the deal
    // panel place a deal by; `stage` is the legacy free-text twin. Moving a
    // deal by `stageId` alone used to leave `stage` stale, so the two
    // disagreed. Validate the target and keep `stage` in step unless the
    // caller sets it explicitly.
    let targetStage: PipelineStageFlags | undefined;
    if (typeof data.stageId === 'string' && data.stageId !== existing.stageId) {
      targetStage = await loadStage(db, data.stageId);
      if (!targetStage) return error.badRequest(c, 'Unknown pipeline stage');
      if (data.stage === undefined) update.stage = targetStage.id;
    }
    // Keep won/lost status, actualCloseDate and probability in sync with the
    // stage, whichever side of the move initiated it.
    await syncStatusWithStage(db, existing, data, update, targetStage);
    // Re-point the denormalized `customerName` mirror when the deal moves to
    // a different company, so the Company tab doesn't keep showing the old
    // (or no) name.
    if (typeof data.customerId === 'string' && data.customerId !== existing.customerId) {
      update.customerName = await lookupCompanyName(db, data.customerId);
    }
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    // Phase 1 dual-write: mirror the customFields blob into the typed values table.
    await syncValuesForEntity(db, 'opportunity', id, data.customFields as Record<string, unknown> | null | undefined);
    publishUpdateEvents(c, id, existing, update);
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/opportunities] update failed:', err);
    return error.internal(c, 'Failed to update opportunity');
  }
});

app.delete('/:id', requirePermission('opportunities:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Opportunity', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'opportunity',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        name: existing.name,
        amount: existing.amount ?? '0',
        stage: existing.stage,
        status: existing.status,
        customerId: existing.customerId,
      },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/opportunities] delete failed:', err);
    return error.internal(c, 'Failed to delete opportunity');
  }
});

export const opportunitiesRoutes = app;
