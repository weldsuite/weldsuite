/**
 * Internal (service-binding) integration endpoints.
 *
 * integration-sync-worker and integration-webhook-worker call
 *   POST /api/integrations/connections/:id/sync
 *   POST /api/integrations/connections/:id/renew-watch
 * over an `API_WORKER` service binding with NO Clerk JWT — they authenticate
 * with an `X-Internal-Secret` header and identify the tenant via
 * `X-Workspace-Id` (Clerk org id) or `X-Internal-Workspace-Id` (internal
 * workspace id, used by the Google Calendar push-webhook path).
 *
 * This router MUST be mounted at `/api/integrations` BEFORE the global
 * `app.use('/api/*', clerkMiddleware(), ...)` guard. When a request carries no
 * internal headers, the handlers call `next()` so the request falls through to
 * the Clerk-authed integrations router mounted after the guard — platform
 * traffic is unaffected.
 *
 * NOTE: the legacy api-worker equivalents sat BEHIND clerkMiddleware with no
 * internal-secret bypass, so these cross-worker calls have been failing with
 * 401 (see the port report). This router fixes that: internal calls must send
 * a CORRECT X-Internal-Secret. All known callers now do — the GCal
 * push-webhook trigger in integration-webhook-worker was the last one missing
 * it and was updated alongside this port. Any NEW internal caller must send
 * the header before W5 retargeting, or it will fail closed (401) while its
 * own error handling may only log.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { getMasterDb, getTenantDbForWorkspace, getWorkspaceForOrg, masterSchema, schema, type Database } from '../../db';
import {
  triggerConnectionSync,
  renewGoogleCalendarWatch,
  type IntegrationsEnv,
} from '../../services/integrations/connections';
import { getConnectionById } from '../../services/connectors/connections';
import { syncConnection } from '../../services/connectors/sync';
import { processConnectorWebhook } from '../../services/connectors/webhooks';
import { completeWooCommerceAppAuth } from '../../services/connectors/auth';
import { touchConnectorIndexIngested } from '../../lib/connector-sync-index';
import { decryptAccessToken, syncSelectedAccounts } from '../../services/ads/sync';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

interface InternalContext {
  db: Database;
  clerkOrgId: string;
}

type ResolveResult =
  | { kind: 'passthrough' }
  | { kind: 'response'; response: Response }
  | { kind: 'ok'; ctx: InternalContext };

/**
 * Authenticate an internal call and resolve its tenant DB.
 * - No internal headers → passthrough (fall through to the Clerk-authed router).
 * - Wrong/missing secret with internal headers present → 401.
 */
async function resolveInternal(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<ResolveResult> {
  const secret = c.req.header('X-Internal-Secret');
  const clerkOrgHeader = c.req.header('X-Workspace-Id');
  const internalWorkspaceHeader = c.req.header('X-Internal-Workspace-Id');

  if (secret === undefined && !clerkOrgHeader && !internalWorkspaceHeader) {
    return { kind: 'passthrough' };
  }

  if (!c.env.INTERNAL_API_SECRET || secret !== c.env.INTERNAL_API_SECRET) {
    return { kind: 'response', response: error.unauthorized(c, 'Invalid internal secret') };
  }

  let clerkOrgId = clerkOrgHeader;
  if (!clerkOrgId && internalWorkspaceHeader) {
    // Google Calendar webhook path identifies the tenant by INTERNAL workspace
    // id (from the intconn:* KV mapping) — resolve it to the Clerk org id.
    const masterDb = getMasterDb(c.env);
    const [ws] = await masterDb
      .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.id, internalWorkspaceHeader))
      .limit(1);
    clerkOrgId = ws?.clerkOrgId ?? undefined;
  }

  if (!clerkOrgId) {
    return { kind: 'response', response: error.badRequest(c, 'X-Workspace-Id or X-Internal-Workspace-Id header required') };
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, clerkOrgId);
    return { kind: 'ok', ctx: { db, clerkOrgId } };
  } catch (err) {
    console.error('[app-api/integrations-internal] tenant resolution failed:', err);
    return { kind: 'response', response: error.notFound(c, 'Workspace', clerkOrgId) };
  }
}

// ============================================================================
// POST /connections/:id/sync — internal sync trigger
// ============================================================================

app.post('/connections/:id/sync', async (c, next: Next) => {
  const resolved = await resolveInternal(c);
  if (resolved.kind === 'passthrough') return next();
  if (resolved.kind === 'response') return resolved.response;

  const { db, clerkOrgId } = resolved.ctx;
  const id = c.req.param('id');

  // Optional body: { syncType?: 'full' | 'incremental' } — the GCal webhook
  // sends 'incremental'; the cron sweep sends no body (defaults to 'full').
  let syncType: 'full' | 'incremental' = 'full';
  try {
    const body = (await c.req.json()) as { syncType?: string } | null;
    if (body?.syncType === 'incremental') syncType = 'incremental';
  } catch {
    // No/invalid JSON body — keep default
  }

  try {
    const result = await triggerConnectionSync(db, c.env as IntegrationsEnv, clerkOrgId, id, syncType);
    if (!result.ok) {
      if (result.code === 'not_found') return error.notFound(c, 'Connection', id);
      if (result.code === 'conflict') return error.conflict(c, result.message);
      return error.badRequest(c, result.message);
    }
    return success(c, { message: result.message });
  } catch (err) {
    console.error('[app-api/integrations-internal] sync trigger failed:', err);
    return error.internal(c, 'Failed to trigger sync');
  }
});

// ============================================================================
// POST /connections/:id/renew-watch — internal Google Calendar watch renewal
// ============================================================================

app.post('/connections/:id/renew-watch', async (c, next: Next) => {
  const resolved = await resolveInternal(c);
  if (resolved.kind === 'passthrough') return next();
  if (resolved.kind === 'response') return resolved.response;

  const { db } = resolved.ctx;
  const id = c.req.param('id');

  try {
    const result = await renewGoogleCalendarWatch(db, c.env as IntegrationsEnv, id);
    if (!result.ok) {
      if (result.code === 'not_found') return error.notFound(c, 'Connection', id);
      return error.internal(c, result.message);
    }
    return success(c, { message: result.message });
  } catch (err) {
    console.error('[app-api/integrations-internal] watch renewal failed:', err);
    return error.internal(c, 'Failed to renew watch channel');
  }
});

// ============================================================================
// POST /connections/:id/connector-event — inbound Woo/Shopify webhook ingest
// ============================================================================

app.post('/connections/:id/connector-event', async (c, next: Next) => {
  const resolved = await resolveInternal(c);
  if (resolved.kind === 'passthrough') return next();
  if (resolved.kind === 'response') return resolved.response;

  const { db } = resolved.ctx;
  const id = c.req.param('id');
  const row = await getConnectionById(db, id);
  if (!row) return error.notFound(c, 'Connection', id);

  const rawBody = await c.req.text();
  const workspaceId = c.req.header('X-Internal-Workspace-Id') ?? resolved.ctx.clerkOrgId;

  try {
    const result = await processConnectorWebhook({
      db,
      env: c.env,
      connection: row,
      ownerId: 'system',
      workspaceId,
      rawBody,
      headers: c.req.raw.headers,
    });
    return c.json({ data: { message: result.message } }, result.status as 200 | 400 | 401 | 500);
  } catch (err) {
    console.error('[app-api/integrations-internal] connector webhook failed:', err);
    return error.internal(c, 'Failed to ingest connector webhook');
  }
});

// ============================================================================
// POST /connections/:id/catch-up — D1-scheduled probe hit / reconcile drift
// ============================================================================

app.post('/connections/:id/catch-up', async (c, next: Next) => {
  const resolved = await resolveInternal(c);
  if (resolved.kind === 'passthrough') return next();
  if (resolved.kind === 'response') return resolved.response;

  const { db, clerkOrgId } = resolved.ctx;
  const id = c.req.param('id');
  const row = await getConnectionById(db, id);
  if (!row) return error.notFound(c, 'Connection', id);
  if (row.status === 'paused') return error.badRequest(c, 'Connection is paused');

  try {
    await syncConnection({
      db,
      env: c.env,
      connection: row,
      ownerId: 'system',
      workspaceId: clerkOrgId,
      trigger: 'schedule',
    });
    const fresh = (await getConnectionById(db, id)) ?? row;
    await touchConnectorIndexIngested(c.env, { connection: fresh });
    return success(c, { watermarks: fresh.syncWatermarks ?? {} });
  } catch (err) {
    console.error('[app-api/integrations-internal] connector catch-up failed:', err);
    return error.internal(c, 'Failed to catch up connector');
  }
});

// ============================================================================
// POST /woocommerce-auth — WooCommerce /wc-auth/v1 callback (API keys JSON)
// ============================================================================

app.post('/woocommerce-auth', async (c, next: Next) => {
  const resolved = await resolveInternal(c);
  if (resolved.kind === 'passthrough') return next();
  if (resolved.kind === 'response') return resolved.response;

  const rawBody = await c.req.text();
  try {
    const result = await completeWooCommerceAppAuth({
      env: c.env,
      rawBody,
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    });
    return c.json({ data: { message: result.message } }, result.status as 200 | 400 | 500);
  } catch (err) {
    console.error('[app-api/integrations-internal] WooCommerce auth callback failed:', err);
    return error.internal(c, 'Failed to complete WooCommerce connection');
  }
});

// POST /ad-connections/:id/sync — scheduled/manual WeldAds integration sync
// ============================================================================

app.post('/ad-connections/:id/sync', async (c, next: Next) => {
  const resolved = await resolveInternal(c);
  if (resolved.kind === 'passthrough') return next();
  if (resolved.kind === 'response') return resolved.response;

  const { db, clerkOrgId } = resolved.ctx;
  const id = c.req.param('id');
  const scopeParam = c.req.query('scope');
  const scope =
    scopeParam === 'push' ? 'push' : scopeParam === 'pull' || scopeParam === 'metrics' ? 'pull' : 'full';

  const [connection] = await db
    .select()
    .from(schema.adPlatformConnections)
    .where(and(eq(schema.adPlatformConnections.id, id), isNull(schema.adPlatformConnections.deletedAt)))
    .limit(1);
  if (!connection) return error.notFound(c, 'Ad connection', id);

  const accessToken = await decryptAccessToken(connection.oauthTokens?.accessToken, {
    v1: c.env.DATABASE_ENCRYPTION_KEY,
    v2: c.env.DATABASE_ENCRYPTION_KEY_V2,
  });
  if (!accessToken) return error.badRequest(c, 'Connection has no valid access token');

  try {
    const workspace = await getWorkspaceForOrg(c.env, clerkOrgId);
    const result = await syncSelectedAccounts(
      db,
      c.env,
      id,
      accessToken,
      workspace.id,
      clerkOrgId,
      { scope },
    );
    return success(c, result);
  } catch (err) {
    console.error('[app-api/integrations-internal] ad connection sync failed:', err);
    return error.internal(c, 'Failed to sync ad connection');
  }
});

// POST /ad-events — Meta webhook incremental ingest
// ============================================================================

const adEventSchema = z.object({
  platformAccountId: z.string().min(1),
  platformCampaignId: z.string().optional(),
  objectType: z.enum(['campaign', 'adset', 'ad', 'unknown']).optional(),
});

app.post('/ad-events', async (c, next: Next) => {
  const resolved = await resolveInternal(c);
  if (resolved.kind === 'passthrough') return next();
  if (resolved.kind === 'response') return resolved.response;

  const body = await c.req.json().catch(() => null);
  const parsed = adEventSchema.safeParse(body);
  if (!parsed.success) return error.badRequest(c, 'Invalid ad event payload');

  const { db, clerkOrgId } = resolved.ctx;
  const { platformAccountId, platformCampaignId } = parsed.data;

  try {
    const [account] = await db
      .select({
        id: schema.adAccounts.id,
        connectionId: schema.adAccounts.connectionId,
      })
      .from(schema.adAccounts)
      .where(
        and(
          eq(schema.adAccounts.platformAccountId, platformAccountId),
          eq(schema.adAccounts.isSelected, true),
          isNull(schema.adAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!account) return success(c, { skipped: true, reason: 'account_not_selected' });

    const [connection] = await db
      .select()
      .from(schema.adPlatformConnections)
      .where(and(eq(schema.adPlatformConnections.id, account.connectionId), isNull(schema.adPlatformConnections.deletedAt)))
      .limit(1);
    if (!connection?.oauthTokens?.accessToken) {
      return success(c, { skipped: true, reason: 'missing_token' });
    }

    const accessToken = await decryptAccessToken(connection.oauthTokens.accessToken, {
      v1: c.env.DATABASE_ENCRYPTION_KEY,
      v2: c.env.DATABASE_ENCRYPTION_KEY_V2,
    });
    if (!accessToken) return success(c, { skipped: true, reason: 'invalid_token' });

    const workspace = await getWorkspaceForOrg(c.env, clerkOrgId);
    const result = await syncSelectedAccounts(
      db,
      c.env,
      account.connectionId,
      accessToken,
      workspace.id,
      clerkOrgId,
      {
        scope: 'incremental',
        platformAccountId,
        platformCampaignId,
      },
    );

    return success(c, result);
  } catch (err) {
    console.error('[app-api/integrations-internal] ad event ingest failed:', err);
    return error.internal(c, 'Failed to ingest ad event');
  }
});

export const integrationsInternalRoutes = app;
