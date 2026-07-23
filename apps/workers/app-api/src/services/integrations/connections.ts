/**
 * Integration connection actions shared by the Clerk-authed
 * /api/integrations router and the internal (service-binding) router.
 *
 * Pure functions — no Hono context. Ported from
 * apps/api-worker/src/routes/integrations/index.ts (sync trigger, Google
 * Calendar watch renewal, CRM_SYNC workflow dispatch).
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';
import type { Env } from '../../types';
import { getOAuthAdapter } from './oauth-providers';

/**
 * Env fields used by the integrations surface that are not (yet) declared in
 * src/types.ts. The integrator should fold these into the canonical Env; until
 * then routes cast through this extension type.
 */
export interface IntegrationsEnvExtra {
  /** Attio OAuth app credentials. */
  ATTIO_CLIENT_ID?: string;
  ATTIO_CLIENT_SECRET?: string;
  /** HubSpot OAuth app credentials. */
  HUBSPOT_CLIENT_ID?: string;
  HUBSPOT_CLIENT_SECRET?: string;
  /** Google Calendar OAuth app credentials (distinct from GOOGLE_CLIENT_ID,
   *  which belongs to the WeldConnect workflow-integrations app). */
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  /** Discord OAuth app credentials + bot token (WeldDesk channel integration). */
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  /**
   * CRM sync engine — CrmSyncWorkflow HOSTED BY integration-webhook-worker
   * (workflow names crm-sync-int[-dev/-test/-preview]); bound cross-script via
   * `script_name = "weldsuite-integration-webhooks*"`, same pattern as the
   * GITHUB_PROJECT_SYNC bindings.
   */
  CRM_SYNC?: Workflow;
}

export type IntegrationsEnv = Env & IntegrationsEnvExtra;

/** integration-webhook-worker public hostnames per environment (webhook targets
 *  registered at providers). Same map the legacy api-worker used. */
const WEBHOOK_WORKER_URLS: Record<string, string> = {
  development: 'http://localhost:8790',
  test: 'https://integration-webhooks-test.weldsuite.org',
  preview: 'https://integration-webhooks-preview.weldsuite.org',
  production: 'https://integration-webhooks.weldsuite.org',
};

export function getWebhookWorkerUrl(env: Env): string {
  return WEBHOOK_WORKER_URLS[env.ENVIRONMENT] || WEBHOOK_WORKER_URLS.development;
}

export interface CrmSyncPayload {
  connectionId: string;
  workspaceId: string;
  provider: string;
  syncType: 'full' | 'incremental';
}

/**
 * Dispatch the CRM sync workflow (crm-sync-int*, hosted by
 * integration-webhook-worker) via the cross-script CRM_SYNC binding.
 */
export async function triggerCrmSync(env: IntegrationsEnv, payload: CrmSyncPayload): Promise<void> {
  if (!env.CRM_SYNC) {
    // Local dev without the cross-script binding — log and no-op so connect
    // flows still complete.
    console.warn('[Integrations] CRM_SYNC workflow binding not available; skipping sync dispatch');
    return;
  }
  await env.CRM_SYNC.create({
    id: `${payload.connectionId}-${Date.now()}`,
    params: payload,
  });
  console.log(`[Integrations] CRM sync workflow created for ${payload.connectionId}`);
}

export type ConnectionActionResult =
  | { ok: true; message: string }
  | { ok: false; code: 'not_found' | 'conflict' | 'no_token' | 'internal'; message: string };

/**
 * Trigger a manual/scheduled sync for a connection: stale-lock aware status
 * guard, flips status to `syncing`, dispatches the CRM_SYNC workflow.
 */
export async function triggerConnectionSync(
  db: Database,
  env: IntegrationsEnv,
  clerkOrgId: string,
  connectionId: string,
  syncType: 'full' | 'incremental' = 'full',
): Promise<ConnectionActionResult> {
  const t = schema.integrationConnections;

  const [connection] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, connectionId), isNull(t.deletedAt)))
    .limit(1);

  if (!connection) return { ok: false, code: 'not_found', message: 'Connection not found' };

  // Guard against double-syncing — but treat a 'syncing' status older than
  // 15 minutes as a stale lock (e.g. a workflow that crashed before it could
  // reset the status) and allow a fresh run rather than blocking forever.
  if (connection.status === 'syncing') {
    const lastTouched = (connection.updatedAt ?? connection.createdAt)?.getTime() ?? 0;
    const STALE_SYNC_MS = 15 * 60 * 1000;
    if (Date.now() - lastTouched < STALE_SYNC_MS) {
      return { ok: false, code: 'conflict', message: 'A sync is already in progress' };
    }
    console.warn(
      `[Integrations] Connection ${connectionId} stuck in 'syncing' since ${connection.updatedAt?.toISOString()} — treating as stale and re-running`,
    );
  }

  const tokens = connection.oauthTokens as { accessToken: string } | null;
  if (!tokens?.accessToken) {
    return { ok: false, code: 'no_token', message: 'No access token available' };
  }

  await db.update(t).set({ status: 'syncing', updatedAt: new Date() }).where(eq(t.id, connectionId));

  await triggerCrmSync(env, {
    connectionId,
    workspaceId: clerkOrgId,
    provider: connection.provider,
    syncType,
  });

  return { ok: true, message: 'Sync started' };
}

/**
 * Renew the Google Calendar push watch channel for a connection: refresh the
 * access token when possible, stop the old channel, register a fresh one and
 * persist the new webhook id/secret.
 */
export async function renewGoogleCalendarWatch(
  db: Database,
  env: IntegrationsEnv,
  connectionId: string,
): Promise<ConnectionActionResult> {
  const t = schema.integrationConnections;

  const [connection] = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.id, connectionId),
        eq(t.provider, 'google_calendar'),
        isNull(t.deletedAt),
      ),
    )
    .limit(1);

  if (!connection) return { ok: false, code: 'not_found', message: 'Connection not found' };

  const tokens = connection.oauthTokens as { accessToken: string; refreshToken?: string } | null;
  if (!tokens?.accessToken) return { ok: false, code: 'no_token', message: 'No access token' };

  const adapter = getOAuthAdapter('google_calendar');

  // Refresh token if possible
  let accessToken = tokens.accessToken;
  if (tokens.refreshToken && env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET) {
    try {
      const newTokens = await adapter.refreshAccessToken(
        env.GOOGLE_CALENDAR_CLIENT_ID,
        env.GOOGLE_CALENDAR_CLIENT_SECRET,
        tokens.refreshToken,
      );
      accessToken = newTokens.accessToken;
      await db
        .update(t)
        .set({ oauthTokens: newTokens, updatedAt: new Date() })
        .where(eq(t.id, connectionId));
    } catch {
      // Use existing token if refresh fails
    }
  }

  // Stop old watch channel
  if (connection.webhookId) {
    try {
      await adapter.deleteWebhooks(accessToken, connection.webhookId, connection.webhookSecret || undefined);
    } catch (err) {
      console.warn('[Integrations] Failed to stop old watch channel:', err);
    }
  }

  // Register new watch channel (gcal-prefixed webhook path)
  const webhookTargetUrl = `${getWebhookWorkerUrl(env)}/webhook/gcal/${connectionId}`;
  const webhookReg = await adapter.registerWebhooks(accessToken, webhookTargetUrl, adapter.supportedEntities);

  await db
    .update(t)
    .set({
      webhookId: webhookReg.webhookId,
      webhookSecret: webhookReg.secret,
      updatedAt: new Date(),
    })
    .where(eq(t.id, connectionId));

  return { ok: true, message: 'Watch channel renewed' };
}
