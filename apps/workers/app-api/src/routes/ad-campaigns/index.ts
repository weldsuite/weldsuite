/**
 * Ad campaign routes — /api/ad-campaigns/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { schema } from '../../db';
import {
  createLocalCampaign,
  setLocalCampaignStatus,
  updateLocalCampaign,
} from '../../services/ads/campaigns';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const campaigns = schema.adCampaigns;
const accounts = schema.adAccounts;

const objectiveSchema = z.enum([
  'OUTCOME_TRAFFIC',
  'OUTCOME_SALES',
  'OUTCOME_LEADS',
  'OUTCOME_AWARENESS',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_APP_PROMOTION',
]);

const statusSchema = z.enum(['ACTIVE', 'PAUSED']);

const createSchema = z
  .object({
    adAccountId: z.string().min(1),
    name: z.string().trim().min(1).max(255),
    objective: objectiveSchema,
    status: statusSchema.optional(),
    dailyBudget: z.number().int().positive().optional(),
    lifetimeBudget: z.number().int().positive().optional(),
  })
  .refine((value) => value.dailyBudget != null || value.lifetimeBudget != null, {
    message: 'Either dailyBudget or lifetimeBudget is required',
    path: ['dailyBudget'],
  });

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    objective: objectiveSchema.optional(),
    status: statusSchema.optional(),
    dailyBudget: z.number().int().positive().optional(),
    lifetimeBudget: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      value.name != null ||
      value.objective != null ||
      value.status != null ||
      value.dailyBudget != null ||
      value.lifetimeBudget != null,
    { message: 'At least one field is required' },
  );

app.get('/', requirePermission('ad_campaigns:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(campaigns.deletedAt)];
  if (q.adAccountId) conditions.push(eq(campaigns.adAccountId, q.adAccountId));
  if (q.status) conditions.push(eq(campaigns.status, q.status));
  if (q.syncStatus) conditions.push(eq(campaigns.syncStatus, q.syncStatus as any));
  if (q.search) conditions.push(like(campaigns.name, `%${q.search}%`));

  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: campaigns.createdAt, id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.id, q.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${campaigns.createdAt} < ${cur.createdAt} OR (${campaigns.createdAt} = ${cur.createdAt} AND ${campaigns.id} < ${cur.id}))`,
      );
    }
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({
          id: campaigns.id,
          adAccountId: campaigns.adAccountId,
          platformCampaignId: campaigns.platformCampaignId,
          name: campaigns.name,
          status: campaigns.status,
          objective: campaigns.objective,
          dailyBudget: campaigns.dailyBudget,
          lifetimeBudget: campaigns.lifetimeBudget,
          currency: campaigns.currency,
          metrics: campaigns.metrics,
          metricsSyncedAt: campaigns.metricsSyncedAt,
          syncStatus: campaigns.syncStatus,
          syncError: campaigns.syncError,
          lastSyncedAt: campaigns.lastSyncedAt,
          createdAt: campaigns.createdAt,
          updatedAt: campaigns.updatedAt,
          accountName: accounts.name,
          platformAccountId: accounts.platformAccountId,
        })
        .from(campaigns)
        .innerJoin(accounts, eq(campaigns.adAccountId, accounts.id))
        .where(where)
        .orderBy(desc(campaigns.updatedAt), desc(campaigns.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(campaigns).where(countWhere),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/ad-campaigns] list failed:', err);
    return error.internal(c, 'Failed to list ad campaigns');
  }
});

app.post('/', requirePermission('ad_campaigns:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const input = c.req.valid('json');

  try {
    const row = await createLocalCampaign(db, input);
    publishEntityEvent({
      c,
      entityType: 'ad_campaign',
      action: 'created',
      entityId: row.id,
      data: row as unknown as Record<string, unknown>,
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/ad-campaigns] create failed:', err);
    const message = err instanceof Error ? err.message : 'Failed to create ad campaign';
    return error.badRequest(c, message);
  }
});

app.get('/:id', requirePermission('ad_campaigns:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Ad campaign', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/ad-campaigns] get failed:', err);
    return error.internal(c, 'Failed to fetch ad campaign');
  }
});

app.patch('/:id', requirePermission('ad_campaigns:update'), zValidator('json', patchSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const input = c.req.valid('json');

  try {
    const row = input.status && Object.keys(input).length === 1
      ? await setLocalCampaignStatus(db, id, input.status)
      : await updateLocalCampaign(db, id, input);
    publishEntityEvent({
      c,
      entityType: 'ad_campaign',
      action: 'updated',
      entityId: row.id,
      data: row as unknown as Record<string, unknown>,
    });
    return success(c, row);
  } catch (err) {
    console.error('[app-api/ad-campaigns] patch failed:', err);
    const message = err instanceof Error ? err.message : 'Failed to update ad campaign';
    if (message.includes('not found')) return error.notFound(c, 'Ad campaign', id);
    return error.badRequest(c, message);
  }
});

export const adCampaignsRoutes = app;
