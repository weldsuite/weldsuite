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
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
} from '@weldsuite/core-domain/custom-field-values';
import { schema } from '@weldsuite/worker-kit/db';
import {
  createOpportunity,
  loadStage,
  lookupCompanyName,
  opportunityUpdateEvents,
  buildUpdatePayload,
  syncStatusWithStage,
  type PipelineStageFlags,
} from '@weldsuite/crm-domain/opportunities';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmOpportunities;

async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  if (await hasContextPermission(c, 'opportunities:scope:all')) return undefined;
  return c.get('userId');
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
  try {
    const { id, eventData } = await createOpportunity(db, data, userId);
    // Phase 1 dual-write: mirror the customFields blob into the typed values table.
    await syncValuesForEntity(db, 'opportunity', id, data.customFields as Record<string, unknown> | null | undefined);
    publishEntityEvent({ c, entityType: 'opportunity', entityId: id, action: 'created', data: eventData });
    return success(c, { id }, 201);
  } catch (err) {
    if (err instanceof Error && err.message === 'ownerId required') return error.badRequest(c, err.message);
    console.error('[app-api/opportunities] create failed:', err);
    return error.internal(c, 'Failed to create opportunity');
  }
});

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
    for (const event of opportunityUpdateEvents(id, existing, update)) {
      publishEntityEvent({ c, entityType: 'opportunity', entityId: id, action: event.action, data: event.data });
    }
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
