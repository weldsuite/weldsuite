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
import { eq } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, type Database } from '../../db';
import {
  triggerConnectionSync,
  renewGoogleCalendarWatch,
  type IntegrationsEnv,
} from '../../services/integrations/connections';

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

export const integrationsInternalRoutes = app;
