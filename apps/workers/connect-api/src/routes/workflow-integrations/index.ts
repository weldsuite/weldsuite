/**
 * Workflow integration routes — flat /api/workflow-integrations/* surface.
 *
 * Credentials are never returned to the client — responses include a
 * `hasCredentials` boolean instead.
 *
 * Permissions: integrations:read | integrations:create | integrations:update | integrations:delete.
 */

import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, lt, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { maybeDecryptField } from '@weldsuite/db/lib/crypto';
import { listIntegrations, getIntegrationDef } from '@weldsuite/workflow-integrations';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { workflowIntegrationOAuthRoutes } from './oauth';
import { listSlackChannels, testSlackAuth } from '../../services/workflow-integrations/slack';
import { listGithubRepos, testGithubAuth } from '../../services/workflow-integrations/github';
import {
  testGoogleAuth,
  getGoogleSpreadsheet,
  listGoogleCalendars,
} from '../../services/workflow-integrations/google';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const wi = schema.workflowIntegrations;

// All three share the Google OAuth client and the same userinfo-ping test —
// 'gmail' doesn't match a `startsWith('google')` check, so this is explicit.
const GOOGLE_INTEGRATION_TYPES = new Set(['google_sheets', 'gmail', 'google_calendar']);

// OAuth + API-key connect flow (POST /:provider/authorize|callback|apikey).
app.route('/', workflowIntegrationOAuthRoutes);

// Catalog of available integrations (metadata only — no secrets). Powers the
// integrations marketplace + the builder's action/trigger pickers.
app.get('/catalog', requirePermission('integrations:read'), (c) => {
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

app.get('/', requirePermission('integrations:read'), async (c) => {
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
    const cursor = hasMore && data.length > 0 ? data.at(-1)!.id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, cursor));
  } catch (err) {
    console.error('[app-api/workflow-integrations] list failed:', err);
    return error.internal(c, 'Failed to list workflow integrations');
  }
});

app.get('/categories', requirePermission('integrations:read'), async (c) => {
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
      name: id.charAt(0).toUpperCase() + id.slice(1).replaceAll('_', ' '),
      count,
    }));
    return success(c, data);
  } catch (err) {
    console.error('[app-api/workflow-integrations] categories failed:', err);
    return error.internal(c, 'Failed to fetch integration categories');
  }
});

app.get('/:id', requirePermission('integrations:read'), async (c) => {
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

app.post('/', requirePermission('integrations:create'), zValidator('json', createIntegrationSchema), async (c) => {
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
  app[method]('/:id', requirePermission('integrations:update'), zValidator('json', updateIntegrationSchema), async (c) => {
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
  requirePermission('integrations:update'),
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

app.patch('/:id/disconnect', requirePermission('integrations:update'), async (c) => {
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

app.post('/:id/test', requirePermission('integrations:create'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const encKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };
  try {
    const [integration] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
    if (!integration) return error.notFound(c, 'Integration', id);

    // app_installation integrations (GitHub) have nothing in oauthTokens to
    // check — they mint a fresh installation token from the App's private
    // key on every call, so they branch before the token-presence check below.
    if (integration.type === 'github') {
      const appId = c.env.GITHUB_APP_ID;
      const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
      if (!appId || !privateKey) return error.internal(c, 'GitHub App is not configured');
      const result = await testGithubAuth(
        { appId, privateKey },
        integration.settings as Record<string, unknown> | undefined,
      );
      return success(c, { success: result.ok, message: result.message });
    }

    const tokens = integration.oauthTokens as { accessToken?: string } | null;
    if (!tokens?.accessToken) {
      return success(c, { success: false, message: 'Integration is not connected (no token)' });
    }
    const token = await maybeDecryptField(tokens.accessToken, encKey);

    // Provider-specific cheap ping.
    let ok = false;
    let detail = '';
    if (integration.type === 'slack') {
      const result = await testSlackAuth(token);
      ok = result.ok;
      detail = result.message;
    } else if (GOOGLE_INTEGRATION_TYPES.has(integration.type)) {
      const result = await testGoogleAuth(token);
      ok = result.ok;
      detail = result.message;
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

// Slack channel picker (conversations.list) — the step form calls this once
// a Slack connection is chosen. Namespaced under the provider (`/slack/...`)
// so a future provider's own picker calls (Google Sheets spreadsheets, GitHub
// repos, …) sit the same way: `/:id/<provider>/<resource>`.
app.get('/:id/slack/channels', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const encKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };
  try {
    const [integration] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
    if (!integration) return error.notFound(c, 'Integration', id);
    if (integration.type !== 'slack') return error.badRequest(c, 'Not a Slack integration');

    const tokens = integration.oauthTokens as { accessToken?: string } | null;
    if (!tokens?.accessToken) return error.badRequest(c, 'Integration is not connected');
    const token = await maybeDecryptField(tokens.accessToken, encKey);

    const channels = await listSlackChannels(token);
    return success(c, channels);
  } catch (err) {
    console.error('[connect-api/workflow-integrations] slack channels failed:', err);
    return error.internal(c, 'Failed to list Slack channels');
  }
});

// GitHub repository picker (`installation/repositories`) — same shape as the
// Slack channel picker above. No oauthTokens to decrypt: the installation
// token is minted fresh from the App's private key + the installation id
// stashed in `settings` at connect time (POST /github/link).
app.get('/:id/github/repos', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [integration] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
    if (!integration) return error.notFound(c, 'Integration', id);
    if (integration.type !== 'github') return error.badRequest(c, 'Not a GitHub integration');

    const appId = c.env.GITHUB_APP_ID;
    const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) return error.internal(c, 'GitHub App is not configured');

    const repos = await listGithubRepos(
      { appId, privateKey },
      integration.settings as Record<string, unknown> | undefined,
    );
    return success(c, repos);
  } catch (err) {
    console.error('[connect-api/workflow-integrations] github repos failed:', err);
    return error.internal(c, 'Failed to list GitHub repositories');
  }
});

/** Shared setup for a Google provider's picker routes: load the row, decrypt
 *  its token, and check it is actually that provider's type. */
async function loadGoogleToken(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  id: string,
  expectedType: string,
) {
  const db = c.get('tenantDb');
  const encKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };
  const [integration] = await db.select().from(wi).where(and(eq(wi.id, id), isNull(wi.deletedAt))).limit(1);
  if (!integration) return { error: error.notFound(c, 'Integration', id) } as const;
  if (integration.type !== expectedType) return { error: error.badRequest(c, `Not a ${expectedType} integration`) } as const;
  const tokens = integration.oauthTokens as { accessToken?: string } | null;
  if (!tokens?.accessToken) return { error: error.badRequest(c, 'Integration is not connected') } as const;
  const token = await maybeDecryptField(tokens.accessToken, encKey);
  return { token } as const;
}

// Spreadsheet + sheet-tab picker — one call resolves a pasted spreadsheet
// id/URL and returns its title and tabs (no Drive scope is requested; see
// services/workflow-integrations/google.ts for why there is no "browse my
// Drive" picker here).
app.get('/:id/google_sheets/spreadsheet', requirePermission('integrations:read'), async (c) => {
  const id = c.req.param('id');
  const spreadsheetIdOrUrl = c.req.query('spreadsheetId');
  if (!spreadsheetIdOrUrl) return error.badRequest(c, 'spreadsheetId query param is required');
  const resolved = await loadGoogleToken(c, id, 'google_sheets');
  if ('error' in resolved) return resolved.error;
  try {
    const info = await getGoogleSpreadsheet(resolved.token, spreadsheetIdOrUrl);
    return success(c, info);
  } catch (err) {
    console.error('[connect-api/workflow-integrations] google sheets spreadsheet lookup failed:', err);
    return error.badRequest(c, 'Could not read that spreadsheet. Check the id/URL and that this Google account can open it.');
  }
});

// Calendar picker (calendarList.list) — the google_calendar.create_event step
// form's calendar dropdown.
app.get('/:id/google_calendar/calendars', requirePermission('integrations:read'), async (c) => {
  const id = c.req.param('id');
  const resolved = await loadGoogleToken(c, id, 'google_calendar');
  if ('error' in resolved) return resolved.error;
  try {
    const calendars = await listGoogleCalendars(resolved.token);
    return success(c, calendars);
  } catch (err) {
    console.error('[connect-api/workflow-integrations] google calendar list failed:', err);
    return error.internal(c, 'Failed to list Google calendars');
  }
});

app.delete('/:id', requirePermission('integrations:delete'), async (c) => {
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
