/**
 * Workflow integration routes — flat /api/workflow-integrations/* surface.
 *
 * Credentials are never returned to the client — responses include a
 * `hasCredentials` boolean instead.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, lt, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { maybeDecryptField } from '@weldsuite/db/lib/crypto';
import { listIntegrations, getIntegrationDef } from '@weldsuite/workflow-integrations';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { workflowIntegrationOAuthRoutes } from './oauth';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const wi = schema.workflowIntegrations;

// OAuth + API-key connect flow (POST /:provider/authorize|callback|apikey).
app.route('/', workflowIntegrationOAuthRoutes);

// Catalog of available integrations (metadata only — no secrets). Powers the
// integrations marketplace + the builder's action/trigger pickers.
app.get('/catalog', requirePermission('tasks:read'), (c) => {
  return success(c, listIntegrations());
});

const createIntegrationSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.string().default('custom'),
  category: z.string().optional(),
  icon: z.string().optional(),
  credentials: z.record(z.unknown()).optional(),
  settings: z.record(z.unknown()).optional(),
  isOAuth: z.boolean().optional(),
  oauthProvider: z.string().optional(),
});

const updateIntegrationSchema = createIntegrationSchema.partial();

type Integration = typeof wi.$inferSelect;

function stripCredentials(row: Integration) {
  const { credentials, oauthTokens, ...rest } = row;
  return { ...rest, hasCredentials: !!credentials, hasOauthTokens: !!oauthTokens };
}

app.get('/', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const filterConditions: any[] = [isNull(wi.deletedAt)];
  if (q.search) filterConditions.push(like(wi.name, `%${q.search}%`));
  if (q.category) filterConditions.push(eq(wi.category, q.category));
  if (q.status) filterConditions.push(eq(wi.status, q.status));
  if (q.type) filterConditions.push(eq(wi.type, q.type));

  const conditions = [...filterConditions];
  if (q.cursor) conditions.push(lt(wi.id, q.cursor));

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(wi).where(and(...conditions)).orderBy(desc(wi.updatedAt), desc(wi.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)::int` }).from(wi).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const data = sliced.map(stripCredentials);
    const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, cursor));
  } catch (err) {
    console.error('[app-api/workflow-integrations] list failed:', err);
    return error.internal(c, 'Failed to list workflow integrations');
  }
});

app.get('/categories', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await db.select({ category: wi.category }).from(wi).where(isNull(wi.deletedAt));
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const cat = r.category || 'custom';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    const data = Object.entries(counts).map(([id, count]) => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' '),
      count,
    }));
    return success(c, data);
  } catch (err) {
    console.error('[app-api/workflow-integrations] categories failed:', err);
    return error.internal(c, 'Failed to fetch integration categories');
  }
});

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Integration', id);
    return success(c, stripCredentials(row));
  } catch (err) {
    console.error('[app-api/workflow-integrations] get failed:', err);
    return error.internal(c, 'Failed to fetch integration');
  }
});

app.post('/', requirePermission('tasks:create'), zValidator('json', createIntegrationSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const id = generateId('int');
    const now = new Date();
    await db.insert(wi).values({
      id,
      name: data.name,
      description: data.description ?? null,
      type: data.type,
      category: data.category ?? null,
      icon: data.icon ?? null,
      credentials: (data.credentials ?? null) as any,
      settings: (data.settings ?? null) as any,
      isOAuth: data.isOAuth ?? false,
      oauthProvider: data.oauthProvider ?? null,
      status: 'disconnected',
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(wi).where(eq(wi.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'workflow_integration',
      entityId: id,
      action: 'created',
      data: { id, name: data.name, type: data.type, category: data.category },
    });
    return success(c, stripCredentials(row), 201);
  } catch (err) {
    console.error('[app-api/workflow-integrations] create failed:', err);
    return error.internal(c, 'Failed to create integration');
  }
});

for (const method of ['put', 'patch'] as const) {
  app[method]('/:id', requirePermission('tasks:update'), zValidator('json', updateIntegrationSchema), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const [existing] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
      if (!existing) return error.notFound(c, 'Integration', id);

      const update: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of ['name', 'description', 'category', 'icon', 'credentials', 'settings', 'type', 'isOAuth', 'oauthProvider'] as const) {
        if (data[k] !== undefined) update[k] = data[k];
      }
      await db.update(wi).set(update).where(eq(wi.id, id));
      const [row] = await db.select().from(wi).where(eq(wi.id, id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'workflow_integration',
        entityId: id,
        action: 'updated',
        data: { id },
      });
      return success(c, stripCredentials(row));
    } catch (err) {
      console.error('[app-api/workflow-integrations] update failed:', err);
      return error.internal(c, 'Failed to update integration');
    }
  });
}

app.patch(
  '/:id/connect',
  requirePermission('tasks:update'),
  zValidator('json', z.object({ credentials: z.record(z.unknown()).optional() })),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const { credentials } = c.req.valid('json');
    try {
      const [existing] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
      if (!existing) return error.notFound(c, 'Integration', id);

      const update: Record<string, unknown> = {
        status: 'connected',
        connectedAt: new Date(),
        connectedBy: userId,
        updatedAt: new Date(),
      };
      if (credentials) update.credentials = credentials;
      await db.update(wi).set(update).where(eq(wi.id, id));
      publishEntityEvent({
        c,
        entityType: 'workflow_integration',
        entityId: id,
        action: 'updated',
        data: { id, status: 'connected' },
      });
      return success(c, { id, status: 'connected' });
    } catch (err) {
      console.error('[app-api/workflow-integrations] connect failed:', err);
      return error.internal(c, 'Failed to connect integration');
    }
  },
);

app.patch('/:id/disconnect', requirePermission('tasks:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Integration', id);
    await db
      .update(wi)
      .set({ status: 'disconnected', updatedAt: new Date() })
      .where(eq(wi.id, id));

    // Drop the inbound-webhook KV mappings so events stop resolving here.
    await c.env.WORKSPACE_CACHE.delete(`intconn:${id}`);
    const teamId = (existing.settings as { teamId?: string } | null)?.teamId;
    if (teamId) await c.env.WORKSPACE_CACHE.delete(`slack_team:${teamId}`);

    publishEntityEvent({
      c,
      entityType: 'workflow_integration',
      entityId: id,
      action: 'updated',
      data: { id, status: 'disconnected' },
    });
    return success(c, { id, status: 'disconnected' });
  } catch (err) {
    console.error('[app-api/workflow-integrations] disconnect failed:', err);
    return error.internal(c, 'Failed to disconnect integration');
  }
});

app.post('/:id/test', requirePermission('tasks:create'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const encKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };
  try {
    const [integration] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
    if (!integration) return error.notFound(c, 'Integration', id);

    const tokens = integration.oauthTokens as { accessToken?: string } | null;
    if (!tokens?.accessToken) {
      return success(c, { success: false, message: 'Integration is not connected (no token)' });
    }
    const token = await maybeDecryptField(tokens.accessToken, encKey);

    // Provider-specific cheap ping.
    let ok = false;
    let detail = '';
    if (integration.type === 'slack') {
      const r = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await r.json()) as { ok: boolean; team?: string; error?: string };
      ok = j.ok;
      detail = j.ok ? `Connected to ${j.team ?? 'Slack'}` : (j.error ?? 'auth.test failed');
    } else if (integration.type.startsWith('google')) {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      ok = r.ok;
      detail = r.ok ? 'Google token valid' : `userinfo returned ${r.status}`;
    } else {
      ok = true;
      detail = 'Token present';
    }
    return success(c, { success: ok, message: detail });
  } catch (err) {
    console.error('[app-api/workflow-integrations] test failed:', err);
    return error.internal(c, 'Failed to test integration');
  }
});

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Integration', id);
    await db.update(wi).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(wi.id, id));
    publishEntityEvent({
      c,
      entityType: 'workflow_integration',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/workflow-integrations] delete failed:', err);
    return error.internal(c, 'Failed to delete integration');
  }
});

export const workflowIntegrationsRoutes = app;
