/**
 * Opportunities routes — flat /api/opportunities/* surface backed by `crm_opportunities`.
 *
 * Permissions: opportunities:read | opportunities:create | opportunities:update | opportunities:delete.
 *   opportunities:scope:all elevates from own-only default to cross-owner access.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import {
  ensurePermissionsResolved,
  requirePermission,
} from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createOpportunitySchema,
  updateOpportunitySchema,
} from '@weldsuite/core-api-client/schemas/opportunities';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
} from '../../services/custom-field-values';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmOpportunities;

const NUMERIC_FIELDS = new Set(['amount', 'expectedRevenue', 'recurringRevenue']);
const DATE_FIELDS = new Set(['closeDate', 'startDate', 'nextStepDate']);

async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  const perms = resolved?.permissions ?? [];
  if (hasPermission(perms, 'opportunities:scope:all')) return undefined;
  return c.get('userId');
}

app.get('/', requirePermission('opportunities:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const scope = await scopeFor(c);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.stage) conditions.push(eq(t.stage, q.stage));
  if (q.pipeline) conditions.push(eq(t.pipeline, q.pipeline));
  if (q.ownerId) conditions.push(eq(t.ownerId, q.ownerId));
  if (q.customerId) conditions.push(eq(t.customerId, q.customerId));
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
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = and(...conditions);
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;

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
    const values: typeof t.$inferInsert = {
      id,
      name: data.name,
      description: data.description,
      customerId: data.customerId,
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

app.patch('/:id', requirePermission('opportunities:update'), zValidator('json', updateOpportunitySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Opportunity', id);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (NUMERIC_FIELDS.has(k) && typeof v === 'number') update[k] = String(v);
      else if (DATE_FIELDS.has(k) && typeof v === 'string') update[k] = new Date(v);
      else update[k] = v;
    }
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    // Phase 1 dual-write: mirror the customFields blob into the typed values table.
    await syncValuesForEntity(db, 'opportunity', id, data.customFields as Record<string, unknown> | null | undefined);
    const newStage = (update.stage as string | undefined) ?? existing.stage;
    const newStatus = (update.status as string | undefined) ?? existing.status;
    const eventData = {
      id,
      name: (update.name as string | undefined) ?? existing.name,
      amount: (update.amount as string | undefined) ?? existing.amount ?? '0',
      stage: newStage,
      status: newStatus,
      customerId: (update.customerId as string | null | undefined) ?? existing.customerId,
      ownerId: (update.ownerId as string | null | undefined) ?? existing.ownerId,
    };
    publishEntityEvent({
      c,
      entityType: 'opportunity',
      entityId: id,
      action: 'updated',
      data: eventData,
    });
    if (newStage !== existing.stage) {
      publishEntityEvent({
        c,
        entityType: 'opportunity',
        entityId: id,
        action: 'stage_changed',
        data: eventData,
      });
    }
    if (newStatus === 'won' && existing.status !== 'won') {
      publishEntityEvent({
        c,
        entityType: 'opportunity',
        entityId: id,
        action: 'won',
        data: eventData,
      });
    } else if (newStatus === 'lost' && existing.status !== 'lost') {
      publishEntityEvent({
        c,
        entityType: 'opportunity',
        entityId: id,
        action: 'lost',
        data: eventData,
      });
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
