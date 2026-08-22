/**
 * Ad campaign routes — /api/ad-campaigns/*
 */

import { Hono } from 'hono';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const campaigns = schema.adCampaigns;
const accounts = schema.adAccounts;

app.get('/', requirePermission('ad_campaigns:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(campaigns.deletedAt)];
  if (q.adAccountId) conditions.push(eq(campaigns.adAccountId, q.adAccountId));
  if (q.status) conditions.push(eq(campaigns.status, q.status));
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

export const adCampaignsRoutes = app;
