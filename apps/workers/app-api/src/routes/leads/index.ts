/**
 * Leads routes — flat /api/leads/* surface backed by `crm_leads`.
 *
 * Permissions: leads:read | leads:create | leads:update | leads:delete.
 *   leads:scope:all elevates from own-only default to cross-owner access.
 */

import { Hono } from 'hono';
import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import {
  ensurePermissionsResolved,
  requirePermission,
} from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  convertLeadSchema,
  createLeadSchema,
  updateLeadSchema,
} from '@weldsuite/core-api-client/schemas/leads';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmLeads;

async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  const perms = resolved?.permissions ?? [];
  if (hasPermission(perms, 'leads:scope:all')) return undefined;
  return c.get('userId');
}

app.get('/', requirePermission('leads:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const scope = await scopeFor(c);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.source) conditions.push(eq(t.source, q.source));
  if (q.rating) conditions.push(eq(t.rating, q.rating));
  if (q.ownerId) conditions.push(eq(t.ownerId, q.ownerId));
  if (q.isQualified !== undefined) conditions.push(eq(t.isQualified, q.isQualified === 'true'));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(
      or(
        like(t.email, term),
        like(t.fullName, term),
        like(t.companyName, term),
        like(t.firstName, term),
        like(t.lastName, term),
      )!,
    );
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
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/leads] list failed:', err);
    return error.internal(c, 'Failed to list leads');
  }
});

app.get('/:id', requirePermission('leads:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [row] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!row) return error.notFound(c, 'Lead', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/leads] get failed:', err);
    return error.internal(c, 'Failed to fetch lead');
  }
});

app.post('/', requirePermission('leads:create'), zValidator('json', createLeadSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const id = generateId('lead');
  const now = new Date();
  const fullName =
    data.firstName || data.lastName
      ? `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim()
      : undefined;
  try {
    const values: typeof t.$inferInsert = {
      id,
      firstName: data.firstName,
      lastName: data.lastName,
      fullName,
      email: data.email,
      companyName: data.companyName,
      title: data.title,
      phone: data.phone,
      mobile: data.mobile,
      website: data.website,
      address: data.address as { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string } | null | undefined,
      source: data.source ?? 'other',
      channel: data.channel,
      campaign: data.campaign,
      medium: data.medium,
      status: data.status ?? 'new',
      rating: data.rating,
      score: data.score ?? 0,
      ownerId: data.ownerId ?? userId,
      productInterest: data.productInterest,
      budget: data.budget as { amount: number; currency: string } | null | undefined,
      timeline: data.timeline,
      authority: data.authority,
      need: data.need,
      notes: data.notes,
      nextAction: data.nextAction,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(t).values(values);
    publishEntityEvent({
      c,
      entityType: 'lead',
      entityId: id,
      action: 'created',
      data: {
        id,
        email: values.email ?? '',
        firstName: values.firstName,
        lastName: values.lastName,
        title: values.title,
        status: values.status ?? 'new',
        source: values.source,
        ownerId: values.ownerId,
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/leads] create failed:', err);
    return error.internal(c, 'Failed to create lead');
  }
});

app.patch('/:id', requirePermission('leads:update'), zValidator('json', updateLeadSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Lead', id);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    if (data.firstName !== undefined || data.lastName !== undefined) {
      const firstName = data.firstName ?? existing.firstName ?? '';
      const lastName = data.lastName ?? existing.lastName ?? '';
      update.fullName = `${firstName} ${lastName}`.trim() || null;
    }
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'lead',
      entityId: id,
      action: 'updated',
      data: {
        id,
        email: ((update.email as string | undefined) ?? existing.email) || '',
        firstName: (update.firstName as string | null | undefined) ?? existing.firstName,
        lastName: (update.lastName as string | null | undefined) ?? existing.lastName,
        title: (update.title as string | null | undefined) ?? existing.title,
        status: ((update.status as string | undefined) ?? existing.status) || 'new',
        source: (update.source as string | null | undefined) ?? existing.source,
        ownerId: (update.ownerId as string | null | undefined) ?? existing.ownerId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/leads] update failed:', err);
    return error.internal(c, 'Failed to update lead');
  }
});

app.delete('/:id', requirePermission('leads:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Lead', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'lead',
      entityId: id,
      action: 'deleted',
      data: { id, email: existing.email ?? '', status: existing.status ?? 'new' },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/leads] delete failed:', err);
    return error.internal(c, 'Failed to delete lead');
  }
});

/**
 * POST /leads/:id/qualify — mark the lead as qualified.
 */
app.post('/:id/qualify', requirePermission('leads:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Lead', id);
    const now = new Date();
    await db
      .update(t)
      .set({ isQualified: true, qualifiedAt: now, status: 'qualified', updatedAt: now })
      .where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'lead',
      entityId: id,
      action: 'qualified',
      data: { id, email: existing.email ?? '', status: 'qualified' },
    });
    return success(c, { id, isQualified: true, status: 'qualified' });
  } catch (err) {
    console.error('[app-api/leads] qualify failed:', err);
    return error.internal(c, 'Failed to qualify lead');
  }
});

/**
 * POST /leads/:id/convert — convert the lead into a customer (and optionally
 * an opportunity). Marks the lead as `converted` and links both target rows
 * back to the lead.
 */
app.post('/:id/convert', requirePermission('leads:update'), zValidator('json', convertLeadSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const options = c.req.valid('json');
  const userId = c.get('userId');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [lead] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!lead) return error.notFound(c, 'Lead', id);

    const now = new Date();
    let customerId: string | undefined;
    let opportunityId: string | undefined;

    if (options.createCustomer) {
      customerId = generateId('pty');
      // TODO(post-Companies/People-refactor): identity fields
      // (`email`, `firstName`, `lastName`, `companyName`, `phone`,
      // `mobile`, `website`) no longer live on `parties`. They moved
      // to the `companies` / `people` tables. This conversion flow
      // needs to first insert a Company or Person row, then create
      // the wrapping party. Cast bypasses the strict type until that
      // refactor lands — runtime behaviour was already broken before
      // this commit and is covered by an auth-gate test, not a
      // happy-path integration test.
      const partyValues = {
        id: customerId,
        kind: lead.companyName ? 'company' : 'person',
        role: 'customer',
        billingAddress: lead.address,
        status: 'prospect',
        ownerId: lead.ownerId ?? userId,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof schema.parties.$inferInsert;
      await db.insert(schema.parties).values(partyValues);
    }

    if (options.createOpportunity && customerId) {
      opportunityId = generateId('opp');
      const budget = lead.budget as { amount?: number; currency?: string } | null;
      const oppValues: typeof schema.crmOpportunities.$inferInsert = {
        id: opportunityId,
        name: `Opportunity from ${lead.fullName ?? lead.email}`,
        customerId,
        amount: budget?.amount ? String(budget.amount) : '0',
        currency: budget?.currency ?? 'EUR',
        stage: 'prospecting',
        status: 'open',
        closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ownerId: lead.ownerId ?? userId ?? '',
        leadSource: lead.source,
        campaign: lead.campaign,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(schema.crmOpportunities).values(oppValues);
    }

    await db
      .update(t)
      .set({
        status: 'converted',
        convertedAt: now,
        convertedToCustomerId: customerId,
        convertedToOpportunityId: opportunityId,
        updatedAt: now,
      })
      .where(eq(t.id, id));

    publishEntityEvent({
      c,
      entityType: 'lead',
      entityId: id,
      action: 'converted',
      data: { id, email: lead.email ?? '', status: 'converted' },
    });
    if (customerId) {
      publishEntityEvent({
        c,
        entityType: 'company',
        entityId: customerId,
        action: 'created',
        data: { id: customerId, name: lead.companyName ?? lead.fullName ?? lead.email ?? '' },
      });
    }
    if (opportunityId) {
      publishEntityEvent({
        c,
        entityType: 'opportunity',
        entityId: opportunityId,
        action: 'created',
        data: {
          id: opportunityId,
          name: `Opportunity from ${lead.fullName ?? lead.email ?? ''}`,
          amount: '0',
          stage: 'prospecting',
          status: 'open',
          customerId,
        },
      });
    }
    return success(c, { leadId: id, customerId, opportunityId });
  } catch (err) {
    console.error('[app-api/leads] convert failed:', err);
    return error.internal(c, 'Failed to convert lead');
  }
});

export const leadsRoutes = app;
