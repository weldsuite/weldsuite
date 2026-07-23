/**
 * WeldSuite Integration Webhook Worker
 *
 * Dedicated Cloudflare Worker that receives webhooks from external integration
 * providers (Attio, HubSpot, Salesforce, etc.), verifies signatures, fetches
 * full records, and upserts into tenant databases.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { eq, and, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspaceById, getTenantDbForWorkspace, tenantSchema, masterSchema, type TenantDatabase } from './db';
import { getProvider } from './lib/integrations/registry';
import { upsertCompany, upsertPerson, softDeleteByMapping, resolveCompanyByExternalId, resolveEntityByExternalId, upsertNote, softDeleteNote, upsertTask, softDeleteTask, upsertListAndEntry, softDeleteListEntry } from './lib/sync';
import { getValidAccessToken } from './lib/token';
import { encryptField, maybeDecryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { publishEntityEventRaw, matchAndDispatchIntegrationTriggers, retryFailedWebhookDeliveries } from '@weldsuite/entity-events';
import {
  verifySlackSignature,
  parseSlackEventCallback,
  parseSlackSlashCommand,
  type ParsedSlackEvent,
} from './lib/workflow-events/slack';
import { verifyTwilioSignature, parseTwilioSms } from './lib/workflow-events/twilio';
import { verifyGithubSignature, parseGithubEvent } from './lib/workflow-events/github';
import { githubAppWebhookRoutes } from './github/webhook';
import type { OAuthTokens } from '@weldsuite/db/schema';

// ============ Env interface ============

export interface Env {
  HYPERDRIVE_MASTER: Hyperdrive;
  DATABASE_URL_MASTER?: string;
  WORKSPACE_CACHE: KVNamespace;
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  ENVIRONMENT: string;
  /** app-api service binding (weldsuite-app-api[-test]) — Google Calendar
   *  incremental-sync trigger + watch-channel renewal, via app-api's internal
   *  integrations router. */
  APP_API?: Fetcher;
  /**
   * Shared secret for internal service-to-service calls. Must match the target
   * app-api env's INTERNAL_API_SECRET — its internal integrations router fails
   * closed with 401 on a missing/wrong secret, and both callers below only log.
   */
  INTERNAL_API_SECRET?: string;
  /** CRM sync engine — Cloudflare Workflow owned by this worker. */
  CRM_SYNC: Workflow;
  /** WeldConnect workflow engine (hosted in workflow-worker) — dispatched for
   *  inbound `integration_event` triggers. */
  EXECUTE_WORKFLOW?: Workflow;
  /** GitHub Projects (v2) sync workflows — owned by this worker. */
  GITHUB_PROJECT_SYNC: Workflow;
  GITHUB_PROJECT_OUTBOUND: Workflow;
  /** GitHub App credentials (for installation token minting). */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** GitHub App-level webhook secret (X-Hub-Signature-256 verification). */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Slack app signing secret — verifies inbound Slack webhooks. */
  SLACK_SIGNING_SECRET?: string;
  /** Google OAuth client — refreshes expired Sheets/Workspace tokens during the poll. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** OAuth client credentials for refreshing expired provider tokens. */
  ATTIO_CLIENT_ID?: string;
  ATTIO_CLIENT_SECRET?: string;
  HUBSPOT_CLIENT_ID?: string;
  HUBSPOT_CLIENT_SECRET?: string;
  // Entity-event sinks (publishEntityEventRaw). Optional — the publisher
  // no-ops + warns when a binding is absent.
  AUDIT_EVENTS?: Queue;
  WORKFLOW_EVENTS?: Queue;
  ANALYTICS_EVENTS?: Queue;
  REALTIME?: Fetcher;
}

/** Providers eligible for scheduled auto-sync (cron). */
const SYNCABLE_PROVIDERS = new Set([
  'attio', 'hubspot', 'salesforce', 'pipedrive', 'google_calendar',
]);

const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const MIN_SYNC_INTERVAL_HOURS = 1;

// ============ KV key helpers ============

/** KV key for connection → workspace mapping (set during connection creation) */
function connectionKvKey(connectionId: string): string {
  return `intconn:${connectionId}`;
}

interface ConnectionKvEntry {
  workspaceId: string;
  provider: string;
}

/**
 * Emit a WeldCRM entity event for an inbound webhook upsert — the "native-first"
 * seam that lets realtime, audit, workflows and agents react to synced changes.
 * Skips no-op upserts. Best-effort: no-ops + warns if event bindings are absent
 * (they are wired in the Stage-2 integration-worker, not yet in this worker).
 */
async function emitCrmEvent(
  env: Env,
  db: TenantDatabase,
  workspaceId: string,
  entityType: 'company' | 'person',
  action: 'created' | 'updated' | 'skipped',
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (action === 'skipped') return;
  await publishEntityEventRaw({
    env,
    db,
    workspaceId,
    userId: 'system',
    entityType,
    action,
    entityId,
    data,
    source: 'system',
  });
}

// ============ Hono app ============

const app = new Hono<{ Bindings: Env }>();

app.use('*', logger());
app.use('*', cors());

// GitHub App webhook receiver (HMAC-verified) → POST /webhooks/github
app.route('/webhooks', githubAppWebhookRoutes);

// Robots.txt — disallow all indexing
app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

// Health check
app.get('/health', async (c) => {
  const timestamp = new Date().toISOString();
  let dbStatus: 'pass' | 'warn' | 'fail' = 'fail';
  let dbTime = 0;
  let dbError: string | undefined;
  let httpStatus: 200 | 503 = 503;

  try {
    const db = getMasterDb(c.env);
    const start = Date.now();
    await Promise.race([
      db.execute(sql`SELECT 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    dbTime = Date.now() - start;
    dbStatus = dbTime > 1000 ? 'warn' : 'pass';
    httpStatus = 200;
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'unknown error';
  }

  return c.json({
    status: httpStatus === 200 ? dbStatus : 'fail',
    service: 'integration-webhook-worker',
    environment: c.env.ENVIRONMENT,
    timestamp,
    checks: {
      master_db: {
        status: dbStatus,
        componentType: 'datastore',
        observedValue: dbTime,
        observedUnit: 'ms',
        ...(dbError && { error: dbError }),
      },
    },
  }, httpStatus, { 'Cache-Control': 'no-cache, no-store' });
});

// ============ WeldConnect integration triggers (Slack) ============

interface SlackTeamKvEntry {
  workspaceId: string;
  integrationId: string;
}

/**
 * Resolve the workspace that owns a Slack team and dispatch matching
 * `integration_event` workflows. Best-effort — unknown teams are ignored.
 */
async function dispatchSlackEvent(c: any, parsed: ParsedSlackEvent): Promise<void> {
  const mapping = (await c.env.WORKSPACE_CACHE.get(`slack_team:${parsed.teamId}`, 'json')) as
    | SlackTeamKvEntry
    | null;
  if (!mapping) {
    console.warn(`[slack] no workspace mapping for team ${parsed.teamId}`);
    return;
  }
  const db = await getTenantDbForWorkspace(c.env, mapping.workspaceId);
  await matchAndDispatchIntegrationTriggers({
    env: c.env,
    db,
    workspaceId: mapping.workspaceId,
    userId: 'system',
    provider: 'slack',
    event: parsed.event,
    integrationId: mapping.integrationId,
    data: parsed.data,
  });
}

// Slack Events API + slash commands. One app-level URL; the workspace is
// resolved from the payload's team id via the `slack_team:` KV mapping.
app.post('/integration-webhook/slack', async (c) => {
  const rawBody = await c.req.text();
  const timestamp = c.req.header('x-slack-request-timestamp') ?? null;
  const signature = c.req.header('x-slack-signature') ?? null;

  const valid = await verifySlackSignature(c.env.SLACK_SIGNING_SECRET, timestamp, rawBody, signature);
  if (!valid) return c.json({ error: 'invalid signature' }, 401);

  const contentType = c.req.header('content-type') ?? '';

  // Slash commands arrive form-encoded.
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>;
    const parsed = parseSlackSlashCommand(form);
    if (parsed) c.executionCtx.waitUntil(dispatchSlackEvent(c, parsed));
    // Ack immediately so Slack doesn't show a timeout error.
    return c.body(null, 200);
  }

  const payload = JSON.parse(rawBody);
  // URL verification handshake.
  if (payload.type === 'url_verification') {
    return c.json({ challenge: payload.challenge });
  }

  const parsed = parseSlackEventCallback(payload);
  if (parsed) c.executionCtx.waitUntil(dispatchSlackEvent(c, parsed));
  return c.body(null, 200);
});

// Per-connection webhook providers (Twilio, GitHub) resolve the workspace +
// connection from the URL's connectionId and verify with a per-connection secret.
interface LoadedConnection {
  workspaceId: string;
  db: TenantDatabase;
  integration: typeof tenantSchema.workflowIntegrations.$inferSelect;
}

async function loadWorkflowConnection(env: Env, connectionId: string): Promise<LoadedConnection | null> {
  const mapping = (await env.WORKSPACE_CACHE.get(connectionKvKey(connectionId), 'json')) as
    | ConnectionKvEntry
    | null;
  if (!mapping) return null;
  const db = await getTenantDbForWorkspace(env, mapping.workspaceId);
  const [integration] = await db
    .select()
    .from(tenantSchema.workflowIntegrations)
    .where(and(eq(tenantSchema.workflowIntegrations.id, connectionId), isNull(tenantSchema.workflowIntegrations.deletedAt)))
    .limit(1);
  if (!integration) return null;
  return { workspaceId: mapping.workspaceId, db, integration };
}

async function decryptConnectionCred(
  env: Env,
  integration: { credentials: Record<string, unknown> | null },
  field: string,
): Promise<string | undefined> {
  const raw = (integration.credentials as Record<string, string> | null)?.[field];
  if (!raw) return undefined;
  return maybeDecryptField(raw, keyringFromEnv(env));
}

// Twilio inbound SMS — one webhook URL per connection.
app.post('/integration-webhook/twilio/:connectionId', async (c) => {
  const rawBody = await c.req.text();
  const conn = await loadWorkflowConnection(c.env, c.req.param('connectionId'));
  if (!conn) return c.json({ error: 'unknown connection' }, 404);

  const authToken = await decryptConnectionCred(c.env, conn.integration, 'authToken');
  const params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>;
  const valid = await verifyTwilioSignature(authToken, c.req.url, params, c.req.header('x-twilio-signature') ?? null);
  if (!valid) return c.json({ error: 'invalid signature' }, 401);

  const parsed = parseTwilioSms(params);
  if (parsed) {
    c.executionCtx.waitUntil(
      matchAndDispatchIntegrationTriggers({
        env: c.env,
        db: conn.db,
        workspaceId: conn.workspaceId,
        userId: 'system',
        provider: 'twilio',
        event: parsed.event,
        integrationId: conn.integration.id,
        data: parsed.data,
      }),
    );
  }
  // Empty TwiML so Twilio doesn't auto-reply.
  return c.text('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, {
    'Content-Type': 'text/xml',
  });
});

// GitHub inbound issue/PR events — one webhook URL per connection.
app.post('/integration-webhook/github/:connectionId', async (c) => {
  const rawBody = await c.req.text();
  const eventHeader = c.req.header('x-github-event') ?? '';
  if (eventHeader === 'ping') return c.json({ ok: true });

  const conn = await loadWorkflowConnection(c.env, c.req.param('connectionId'));
  if (!conn) return c.json({ error: 'unknown connection' }, 404);

  const secret = await decryptConnectionCred(c.env, conn.integration, 'webhookSecret');
  const valid = await verifyGithubSignature(secret, rawBody, c.req.header('x-hub-signature-256') ?? null);
  if (!valid) return c.json({ error: 'invalid signature' }, 401);

  const parsed = parseGithubEvent(eventHeader, JSON.parse(rawBody));
  if (parsed) {
    c.executionCtx.waitUntil(
      matchAndDispatchIntegrationTriggers({
        env: c.env,
        db: conn.db,
        workspaceId: conn.workspaceId,
        userId: 'system',
        provider: 'github',
        event: parsed.event,
        integrationId: conn.integration.id,
        data: parsed.data,
      }),
    );
  }
  return c.json({ ok: true });
});

// ============ HubSpot webhook handler (single URL for all portals) ============

app.post('/webhook/hubspot', async (c) => {
  const rawBody = await c.req.text();

  try {
    // 1. Extract portalId from payload
    const { extractPortalId } = await import('./lib/integrations/providers/hubspot/index');
    const portalId = extractPortalId(rawBody);
    if (!portalId) {
      console.warn('[Webhook/HubSpot] No portalId in payload');
      return c.json({ error: 'No portalId in payload' }, 400);
    }

    // 2. Find the connection by portalId across all workspaces
    //    First check KV cache, then fall back to DB scan
    const cacheKey = `hubspot_portal:${portalId}`;
    let workspaceId: string | undefined;
    let connectionId: string | undefined;

    const cached = await c.env.WORKSPACE_CACHE.get(cacheKey, 'json') as { workspaceId: string; connectionId: string } | null;
    if (cached) {
      workspaceId = cached.workspaceId;
      connectionId = cached.connectionId;
    } else {
      // Scan all workspaces to find the connection with this externalAccountId.
      // (master `workspaces` has no soft-delete column — no deletedAt filter.)
      const masterDb = getMasterDb(c.env);
      const workspaces = await masterDb
        .select({ id: masterSchema.workspaces.id })
        .from(masterSchema.workspaces);

      for (const ws of workspaces) {
        try {
          const db = await getTenantDbForWorkspaceById(c.env, ws.id);
          const [conn] = await db
            .select({ id: tenantSchema.integrationConnections.id })
            .from(tenantSchema.integrationConnections)
            .where(
              and(
                eq(tenantSchema.integrationConnections.provider, 'hubspot'),
                eq(tenantSchema.integrationConnections.externalAccountId, String(portalId)),
                isNull(tenantSchema.integrationConnections.deletedAt),
              )
            )
            .limit(1);

          if (conn) {
            workspaceId = ws.id;
            connectionId = conn.id;
            // Cache for next time
            await c.env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify({ workspaceId, connectionId }), { expirationTtl: 86400 * 30 });
            break;
          }
        } catch { /* skip workspace */ }
      }
    }

    if (!workspaceId || !connectionId) {
      console.warn(`[Webhook/HubSpot] No connection for portalId: ${portalId}`);
      return c.json({ error: 'Portal not connected' }, 404);
    }

    // 3. Load connection from tenant DB
    const provider = getProvider('hubspot');
    if (!provider) return c.json({ error: 'HubSpot provider not registered' }, 500);

    const tenantDb = await getTenantDbForWorkspaceById(c.env, workspaceId);

    const [connection] = await tenantDb
      .select()
      .from(tenantSchema.integrationConnections)
      .where(
        and(
          eq(tenantSchema.integrationConnections.id, connectionId),
          isNull(tenantSchema.integrationConnections.deletedAt),
        )
      )
      .limit(1);

    if (!connection) {
      // Invalidate stale cache
      await c.env.WORKSPACE_CACHE.delete(cacheKey);
      return c.json({ error: 'Connection not found' }, 404);
    }

    // 4. Verify signature
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

    if (connection.webhookSecret) {
      const valid = await provider.verifyWebhookSignature(rawBody, headers, connection.webhookSecret);
      if (!valid) {
        console.warn(`[Webhook/HubSpot] Invalid signature for portal ${portalId}`);
        return c.json({ error: 'Invalid signature' }, 401);
      }
    }

    // 5. Parse and process events — refresh the token first if expired
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(
        tenantDb,
        { id: connectionId, provider: 'hubspot', oauthTokens: connection.oauthTokens as OAuthTokens | null },
        c.env,
      );
    } catch {
      return c.json({ error: 'No access token' }, 500);
    }

    const payload = provider.parseWebhookPayload(rawBody);
    console.info(`[Webhook/HubSpot] Processing ${payload.events.length} event(s) for portal ${portalId}`);

    let processed = 0;

    for (const event of payload.events) {
      try {
        const entityType = provider.resolveEntityType?.(event);
        if (!entityType) continue;

        if (event.eventType === 'record.deleted') {
          await softDeleteByMapping(tenantDb, connectionId, event.objectType, event.recordId);
          processed++;
          continue;
        }

        if (provider.fetchEntityGeneric) {
          const entity = await provider.fetchEntityGeneric(accessToken, entityType, event.recordId);

          if (entityType === 'company') {
            const mapped = provider.mapCompany({ id: entity.id, type: 'company', data: (entity.data as any).properties || entity.data, raw: entity.raw });
            const result = await upsertCompany(tenantDb, connectionId, 'company', entity.id, mapped, entity.raw);
            await emitCrmEvent(c.env, tenantDb, workspaceId, 'company', result.action, result.companyId, mapped.data as Record<string, unknown>);
          } else if (entityType === 'person') {
            const mapped = provider.mapPerson({ id: entity.id, type: 'person', data: (entity.data as any).properties || entity.data, raw: entity.raw });
            const result = await upsertPerson(tenantDb, connectionId, entity.id, mapped, undefined, entity.raw);
            await emitCrmEvent(c.env, tenantDb, workspaceId, 'person', result.action, result.personId, mapped.data as Record<string, unknown>);
          }

          processed++;
        }
      } catch (err) {
        console.error(`[Webhook/HubSpot] Failed to process event ${event.recordId}:`, err);
      }
    }

    console.info(`[Webhook/HubSpot] Processed ${processed}/${payload.events.length} events`);
    return c.json({ received: true, processed });
  } catch (err) {
    console.error('[Webhook/HubSpot] Handler error:', err);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ============ Google Calendar push notification handler ============

app.post('/webhook/gcal/:connectionId', async (c) => {
  const { connectionId } = c.req.param();

  try {
    // Extract Google-specific headers
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

    const resourceState = headers['x-goog-resource-state'];
    const channelToken = headers['x-goog-channel-token'];

    // Initial sync handshake — just acknowledge
    if (resourceState === 'sync') {
      console.info(`[Webhook/GoogleCalendar] Sync handshake for connection ${connectionId}`);
      return c.json({ status: 'ok', type: 'sync_handshake' });
    }

    // Resolve workspace from KV
    const kvEntry = await c.env.WORKSPACE_CACHE.get(
      connectionKvKey(connectionId),
      'json'
    ) as ConnectionKvEntry | null;

    if (!kvEntry) {
      console.warn(`[Webhook/GoogleCalendar] No KV entry for connection: ${connectionId}`);
      return c.json({ error: 'Connection not found' }, 404);
    }

    // Verify token
    const tenantDb = await getTenantDbForWorkspaceById(c.env, kvEntry.workspaceId);
    const [connection] = await tenantDb
      .select()
      .from(tenantSchema.integrationConnections)
      .where(
        and(
          eq(tenantSchema.integrationConnections.id, connectionId),
          isNull(tenantSchema.integrationConnections.deletedAt),
        )
      )
      .limit(1);

    if (!connection) {
      return c.json({ error: 'Connection not found' }, 404);
    }

    if (connection.webhookSecret && channelToken) {
      try {
        const parsed = JSON.parse(connection.webhookSecret) as { token: string };
        if (parsed.token !== channelToken) {
          console.warn(`[Webhook/GoogleCalendar] Invalid channel token for ${connectionId}`);
          return c.json({ error: 'Invalid token' }, 401);
        }
      } catch {
        console.warn(`[Webhook/GoogleCalendar] Failed to parse webhookSecret for ${connectionId}`);
      }
    }

    // Trigger incremental sync via CRM_SYNC workflow
    if (resourceState === 'exists') {
      console.info(`[Webhook/GoogleCalendar] Change notification for ${connectionId}, triggering incremental sync`);

      if (c.env.APP_API) {
        // Trigger sync via the app-api service binding.
        // X-Internal-Secret is REQUIRED: the app-api internal router
        // (routes/integrations/internal.ts) fails closed with 401 when an
        // internal-header call carries no/wrong secret. The cron sweeps below
        // and in integration-sync-worker already send it; this caller did not,
        // which would have silently stopped every incremental GCal sync at W5
        // retargeting (the !ok branch only logs and still 200s to Google).
        const syncResponse = await c.env.APP_API.fetch(
          new Request('https://internal/api/integrations/connections/' + connectionId + '/sync', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Workspace-Id': kvEntry.workspaceId,
              'X-Internal-Secret': c.env.INTERNAL_API_SECRET || '',
            },
            body: JSON.stringify({ syncType: 'incremental' }),
          }),
        );
        if (!syncResponse.ok) {
          console.error(`[Webhook/GoogleCalendar] Sync trigger failed: ${syncResponse.status}`);
        }
      } else {
        console.warn('[Webhook/GoogleCalendar] APP_API service binding not available');
      }
    }

    return c.json({ status: 'ok', type: 'sync_triggered' });
  } catch (err) {
    console.error('[Webhook/GoogleCalendar] Handler error:', err);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ============ Per-connection webhook handler (Attio, etc.) ============

app.post('/webhook/:connectionId', async (c) => {
  const { connectionId } = c.req.param();
  const rawBody = await c.req.text();

  try {
    // 1. Resolve workspace from KV cache
    const kvEntry = await c.env.WORKSPACE_CACHE.get(
      connectionKvKey(connectionId),
      'json'
    ) as ConnectionKvEntry | null;

    if (!kvEntry) {
      console.warn(`[Webhook] No KV entry for connection: ${connectionId}`);
      return c.json({ error: 'Connection not found' }, 404);
    }

    const { workspaceId, provider: providerName } = kvEntry;

    // 2. Get provider
    const provider = getProvider(providerName);
    if (!provider) {
      console.error(`[Webhook] Unknown provider: ${providerName}`);
      return c.json({ error: 'Unknown provider' }, 400);
    }

    // 3. Get tenant DB and load connection record
    const tenantDb = await getTenantDbForWorkspaceById(c.env, workspaceId);

    const [connection] = await tenantDb
      .select()
      .from(tenantSchema.integrationConnections)
      .where(
        and(
          eq(tenantSchema.integrationConnections.id, connectionId),
          isNull(tenantSchema.integrationConnections.deletedAt),
        )
      )
      .limit(1);

    if (!connection) {
      console.warn(`[Webhook] Connection not found in DB: ${connectionId}`);
      return c.json({ error: 'Connection not found' }, 404);
    }

    // 4. Verify webhook signature
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (connection.webhookSecret) {
      const valid = await provider.verifyWebhookSignature(rawBody, headers, connection.webhookSecret);
      if (!valid) {
        console.warn(`[Webhook] Invalid signature for connection: ${connectionId}`);
        return c.json({ error: 'Invalid signature' }, 401);
      }
    }

    // 5. Parse webhook payload (may contain multiple events)
    console.info(`[Webhook] Raw payload: ${rawBody}`);
    const payload = provider.parseWebhookPayload(rawBody);
    console.info(`[Webhook] Parsed ${payload.events.length} event(s) from webhook ${payload.webhookId}`);

    // 6. Get a valid access token (refreshes + persists if expired)
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(
        tenantDb,
        { id: connectionId, provider: providerName, oauthTokens: connection.oauthTokens as OAuthTokens | null },
        c.env,
      );
    } catch (err) {
      console.error(`[Webhook] No access token for connection: ${connectionId}`, err);
      return c.json({ error: 'No access token' }, 500);
    }

    // 7. Process each event
    let companiesProcessed = 0;
    let peopleProcessed = 0;
    let tasksProcessed = 0;
    let listEntriesProcessed = 0;

    for (const event of payload.events) {
      // ---- Note events ----
      if (event.eventType.startsWith('note.')) {
        console.info(`[Webhook] Processing note event: ${event.eventType} noteId=${event.noteId}`);

        if (event.eventType === 'note.deleted') {
          if (event.noteId) {
            const deleted = await softDeleteNote(tenantDb, connectionId, event.noteId);
            console.info(`[Webhook] Note soft-deleted: ${event.noteId} (found=${deleted})`);
          }
          continue;
        }

        // note.created / note.updated — fetch full note and upsert
        if (!event.noteId) {
          console.warn(`[Webhook] Note event missing noteId, skipping`);
          continue;
        }

        const note = await provider.fetchNote(accessToken, event.noteId);

        // Resolve the parent record (company/person) to a WeldSuite entity
        let parentEntityId: string | undefined;
        let parentEntityType: string | undefined;
        if (note.parentRecordId) {
          const resolved = await resolveEntityByExternalId(tenantDb, connectionId, note.parentRecordId);
          if (resolved) {
            parentEntityId = resolved.internalEntityId;
            parentEntityType = resolved.internalEntityType;
          }
        }

        const result = await upsertNote(
          tenantDb, connectionId, note.id, note, parentEntityId, parentEntityType
        );
        console.info(`[Webhook] Note ${result.action}: ${result.activityId} (parent=${parentEntityType}:${parentEntityId})`);
        continue;
      }

      // ---- Task events ----
      if (event.eventType.startsWith('task.')) {
        console.info(`[Webhook] Processing task event: ${event.eventType} taskId=${event.taskId}`);

        if (event.eventType === 'task.deleted') {
          if (event.taskId) {
            const deleted = await softDeleteTask(tenantDb, connectionId, event.taskId);
            console.info(`[Webhook] Task soft-deleted: ${event.taskId} (found=${deleted})`);
          }
          continue;
        }

        // task.created / task.updated — fetch full task and upsert
        if (!event.taskId) {
          console.warn(`[Webhook] Task event missing taskId, skipping`);
          continue;
        }

        const task = await provider.fetchTask(accessToken, event.taskId);

        // Resolve the first linked record to a WeldSuite entity
        let linkedEntityId: string | undefined;
        let linkedEntityType: string | undefined;
        if (task.linkedRecords.length > 0) {
          const resolved = await resolveEntityByExternalId(
            tenantDb, connectionId, task.linkedRecords[0].targetRecordId
          );
          if (resolved) {
            linkedEntityId = resolved.internalEntityId;
            linkedEntityType = resolved.internalEntityType;
          }
        }

        const taskResult = await upsertTask(
          tenantDb, connectionId, task.id, task, linkedEntityId, linkedEntityType
        );
        console.info(`[Webhook] Task ${taskResult.action}: ${taskResult.activityId} (linked=${linkedEntityType}:${linkedEntityId})`);
        tasksProcessed++;
        continue;
      }

      // ---- List-entry events ----
      if (event.eventType.startsWith('list-entry.')) {
        console.info(`[Webhook] Processing list-entry event: ${event.eventType} entryId=${event.listEntryId} listId=${event.listId}`);

        if (event.eventType === 'list-entry.deleted') {
          if (event.listEntryId) {
            const deleted = await softDeleteListEntry(tenantDb, connectionId, event.listEntryId);
            console.info(`[Webhook] List entry deleted: ${event.listEntryId} (found=${deleted})`);
          }
          continue;
        }

        // list-entry.created / list-entry.updated
        if (!event.listEntryId || !event.listId) {
          console.warn(`[Webhook] List-entry event missing entryId or listId, skipping`);
          continue;
        }

        const listEntry = await provider.fetchListEntry(accessToken, event.listId, event.listEntryId);

        // Resolve parent record to a WeldSuite customer
        const resolvedParent = await resolveEntityByExternalId(
          tenantDb, connectionId, listEntry.parentRecordId
        );
        if (!resolvedParent || resolvedParent.internalEntityType !== 'company') {
          console.warn(`[Webhook] List entry parent record not found or not a company: ${listEntry.parentRecordId}`);
          continue;
        }

        // Fetch lists to get the list name
        const lists = await provider.fetchLists(accessToken);
        const listInfo = lists.find(l => l.listId === listEntry.listId);
        const listName = listInfo?.name || 'Unknown List';

        const entryResult = await upsertListAndEntry(
          tenantDb, connectionId, listEntry.listId, listName,
          listEntry.entryId, resolvedParent.internalEntityId, listEntry.raw
        );
        console.info(`[Webhook] List entry ${entryResult.action}: list=${entryResult.listId} member=${entryResult.memberId}`);
        listEntriesProcessed++;
        continue;
      }

      // ---- Record events ----
      // Resolve object UUID to slug (e.g., "people", "companies")
      const objectType = await provider.resolveObjectSlug(accessToken, event.objectId);
      console.info(`[Webhook] Processing: ${event.eventType} ${objectType} (${event.objectId}) record=${event.recordId}`);

      if (event.eventType === 'record.deleted') {
        // Soft-delete
        const externalType = objectType === 'companies' ? 'company' : 'person';
        await softDeleteByMapping(tenantDb, connectionId, externalType, event.recordId);
        console.info(`[Webhook] Soft-deleted ${externalType} ${event.recordId}`);
      } else {
        // Create/update/merge — fetch full record and upsert
        const record = await provider.fetchRecord(accessToken, objectType, event.recordId);

        if (objectType === 'companies') {
          const mapped = provider.mapCompany(record);
          const result = await upsertCompany(
            tenantDb, connectionId, 'company', record.id, mapped, record.raw
          );
          console.info(`[Webhook] Company ${result.action}: ${result.companyId}`);
          companiesProcessed++;
          await emitCrmEvent(c.env, tenantDb, workspaceId, 'company', result.action, result.companyId, mapped.data as Record<string, unknown>);
        } else if (objectType === 'people') {
          const mapped = provider.mapPerson(record);
          const parentCompanyId = mapped.parentCompanyExternalId
            ? await resolveCompanyByExternalId(tenantDb, connectionId, mapped.parentCompanyExternalId)
            : undefined;
          const result = await upsertPerson(
            tenantDb, connectionId, record.id, mapped, parentCompanyId, record.raw
          );
          console.info(`[Webhook] Person ${result.action}: ${result.personId} (parentCompany=${parentCompanyId ?? 'none'})`);
          peopleProcessed++;
          await emitCrmEvent(c.env, tenantDb, workspaceId, 'person', result.action, result.personId, mapped.data as Record<string, unknown>);
        } else {
          console.warn(`[Webhook] Skipping unknown object type: ${objectType}`);
          continue;
        }

        // For merge events, also soft-delete the merged-from record
        if (event.eventType === 'record.merged' && event.mergedFromId) {
          const externalType = objectType === 'companies' ? 'company' : 'person';
          await softDeleteByMapping(tenantDb, connectionId, externalType, event.mergedFromId);
          console.info(`[Webhook] Soft-deleted merged-from ${externalType} ${event.mergedFromId}`);
        }
      }
    }

    // 8. Update connection stats
    const statsUpdate: Record<string, unknown> = { updatedAt: new Date() };
    if (companiesProcessed > 0) {
      statsUpdate.companiesSynced = sql`${tenantSchema.integrationConnections.companiesSynced} + ${companiesProcessed}`;
    }
    if (peopleProcessed > 0) {
      statsUpdate.peopleSynced = sql`${tenantSchema.integrationConnections.peopleSynced} + ${peopleProcessed}`;
    }
    if (tasksProcessed > 0) {
      statsUpdate.tasksSynced = sql`${tenantSchema.integrationConnections.tasksSynced} + ${tasksProcessed}`;
    }
    if (listEntriesProcessed > 0) {
      statsUpdate.listsSynced = sql`${tenantSchema.integrationConnections.listsSynced} + ${listEntriesProcessed}`;
    }
    if (companiesProcessed > 0 || peopleProcessed > 0 || tasksProcessed > 0 || listEntriesProcessed > 0) {
      await tenantDb
        .update(tenantSchema.integrationConnections)
        .set(statsUpdate)
        .where(eq(tenantSchema.integrationConnections.id, connectionId));
    }

    return c.json({ status: 'ok', processed: payload.events.length });
  } catch (err) {
    console.error('[Webhook] Processing error:', err);
    return c.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      500
    );
  }
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Worker Error:', err);
  return c.json({
    error: 'Internal Server Error',
    message: c.env.ENVIRONMENT === 'production' ? undefined : err.message,
  }, 500);
});

// ============ Scheduled sync (cron) ============
//
// Consolidated from the former integration-sync-worker. Every N minutes, scan
// all workspaces for active connections that are due, and trigger the CRM sync
// Workflow directly via the binding (no api-worker hop).

interface CronSyncSettings {
  syncIntervalHours?: number;
}

async function runScheduledSync(env: Env): Promise<void> {
  console.log(`[IntegrationScheduler] Starting sync check (${env.ENVIRONMENT})`);
  const masterDb = getMasterDb(env);

  const workspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
      databaseUrl: masterSchema.workspaces.databaseUrl,
    })
    .from(masterSchema.workspaces);

  let triggered = 0;
  let skipped = 0;
  const now = Date.now();

  for (const workspace of workspaces) {
    if (!workspace.clerkOrgId) continue;
    try {
      const db = await getTenantDbForWorkspaceById(env, workspace.id);
      const connections = await db
        .select()
        .from(tenantSchema.integrationConnections)
        .where(
          and(
            eq(tenantSchema.integrationConnections.status, 'active'),
            isNull(tenantSchema.integrationConnections.deletedAt),
          )
        );

      for (const connection of connections) {
        if (!SYNCABLE_PROVIDERS.has(connection.provider)) continue;

        const tokens = connection.oauthTokens as { accessToken: string } | null;
        if (!tokens?.accessToken) continue;

        const syncSettings = connection.syncSettings as CronSyncSettings | null;
        const intervalHours = Math.max(
          syncSettings?.syncIntervalHours || DEFAULT_SYNC_INTERVAL_HOURS,
          MIN_SYNC_INTERVAL_HOURS,
        );
        const lastSync = connection.lastSyncAt ? new Date(connection.lastSyncAt).getTime() : 0;
        if (now < lastSync + intervalHours * 60 * 60 * 1000) {
          skipped++;
          continue;
        }

        // Google Calendar watch-channel renewal via app-api's internal router.
        if (connection.provider === 'google_calendar' && connection.webhookSecret && env.APP_API) {
          try {
            const watchInfo = JSON.parse(connection.webhookSecret) as { expiration?: string };
            if (watchInfo.expiration) {
              const expiresAt = Number(watchInfo.expiration);
              if (now > expiresAt - 24 * 60 * 60 * 1000) {
                await env.APP_API.fetch(
                  `https://internal/api/integrations/connections/${connection.id}/renew-watch`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'X-Workspace-Id': workspace.clerkOrgId,
                      'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
                    },
                  },
                );
              }
            }
          } catch (err) {
            console.error(`[IntegrationScheduler] Watch renewal check failed for ${connection.id}:`, err);
          }
        }

        try {
          // Trigger the sync Workflow directly — the engine lives in this worker.
          await env.CRM_SYNC.create({
            params: {
              workspaceId: workspace.clerkOrgId,
              connectionId: connection.id,
              provider: connection.provider,
              syncType: 'incremental',
            },
          });
          // Mark as syncing so the UI reflects it and concurrent triggers dedupe.
          await db
            .update(tenantSchema.integrationConnections)
            .set({ status: 'syncing', updatedAt: new Date() })
            .where(eq(tenantSchema.integrationConnections.id, connection.id));
          triggered++;
        } catch (err) {
          console.error(`[IntegrationScheduler] Failed to trigger sync for ${connection.id}:`, err);
        }
      }
    } catch (err) {
      console.error(`[IntegrationScheduler] Failed to process workspace ${workspace.id}:`, err);
    }
  }

  console.log(`[IntegrationScheduler] Done. Triggered: ${triggered}, Skipped (not due): ${skipped}`);
}

// ============ Integration poll triggers (Sheets / Gmail / Calendar / Airtable) ============

/** Cron pattern that drives the integration polls. Branched on in `scheduled`
 *  so it never co-fires the (intentionally disabled) CRM auto-sync. */
const INTEGRATION_POLL_CRON = '*/10 * * * *';

const TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

async function maybeDecryptToken(value: string, keyring: EncryptionKeyring): Promise<string> {
  // Handles v1 + v2 formats; plaintext passes through.
  return maybeDecryptField(value, keyring);
}

/** Resolve a usable Google access token for a connection, refreshing + persisting if needed. */
async function resolveGoogleToken(
  env: Env,
  db: TenantDatabase,
  integration: any,
): Promise<string | null> {
  const key = keyringFromEnv(env);
  const tokens = integration.oauthTokens as
    | { accessToken?: string; refreshToken?: string; expiresAt?: string }
    | null;
  if (!tokens?.accessToken) return null;

  let accessToken = await maybeDecryptToken(tokens.accessToken, key);
  const expiresMs = tokens.expiresAt ? Date.parse(tokens.expiresAt) : NaN;
  const expiringSoon = Number.isFinite(expiresMs) && expiresMs - Date.now() < TOKEN_REFRESH_WINDOW_MS;

  if (expiringSoon && tokens.refreshToken && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const refreshToken = await maybeDecryptToken(tokens.refreshToken, key);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (res.ok && json.access_token) {
      accessToken = json.access_token;
      await db
        .update(tenantSchema.workflowIntegrations)
        .set({
          oauthTokens: {
            accessToken: key.v1 || key.v2 ? await encryptField(json.access_token, key) : json.access_token,
            refreshToken: tokens.refreshToken,
            expiresAt: json.expires_in
              ? new Date(Date.now() + json.expires_in * 1000).toISOString()
              : undefined,
          },
          updatedAt: new Date(),
        })
        .where(eq(tenantSchema.workflowIntegrations.id, integration.id));
    }
  }
  return accessToken;
}

/** Generic helpers to read poll-trigger config across providers. */
function isPollTrigger(t: any, provider: string, event: string): boolean {
  const p = t?.provider ?? t?.config?.provider;
  const e = t?.event ?? t?.config?.event;
  return t?.type === 'integration_event' && p === provider && e === event;
}
function triggerIntegrationId(t: any): string | undefined {
  return t?.integrationId ?? t?.config?.integrationId;
}
function triggerField(t: any, field: string): string | undefined {
  const fromConfig = t?.config?.[field];
  if (fromConfig !== undefined && fromConfig !== null) return String(fromConfig);
  const f = (t?.filters ?? t?.config?.filters ?? []).find((x: any) => x.field === field);
  return f ? String(f.value) : undefined;
}

interface IntegrationRow {
  id: string;
  type: string;
  settings: Record<string, unknown> | null;
  oauthTokens: unknown;
  credentials: Record<string, unknown> | null;
}

/**
 * Poll-based integration triggers (Google Sheets, Gmail, Google Calendar,
 * Airtable). One workspace loop dispatches new items straight into the
 * EXECUTE_WORKFLOW Cloudflare Workflow. Watched resources are derived from the
 * active workflows' `*.new_*` triggers so a resource is only polled while a
 * workflow listens.
 */
async function runIntegrationPolls(env: Env): Promise<void> {
  if (!env.EXECUTE_WORKFLOW) {
    console.warn('[Poll] EXECUTE_WORKFLOW binding absent — skipping');
    return;
  }
  console.log(`[Poll] Starting (${env.ENVIRONMENT})`);
  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({ id: masterSchema.workspaces.id, clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces);

  let dispatched = 0;

  for (const workspace of workspaces) {
    if (!workspace.clerkOrgId) continue;
    const clerkOrgId = workspace.clerkOrgId;
    try {
      const db = await getTenantDbForWorkspaceById(env, workspace.id);
      const activeWorkflows = await db
        .select({ triggers: tenantSchema.workflows.triggers })
        .from(tenantSchema.workflows)
        .where(and(eq(tenantSchema.workflows.status, 'active'), isNull(tenantSchema.workflows.deletedAt)));

      const triggers = activeWorkflows.flatMap((wf) => (wf.triggers as any[]) || []);
      if (triggers.length === 0) continue;

      const polls = {
        google_sheets: triggers.filter((t) => isPollTrigger(t, 'google_sheets', 'google_sheets.new_row')),
        gmail: triggers.filter((t) => isPollTrigger(t, 'gmail', 'gmail.new_email')),
        google_calendar: triggers.filter((t) => isPollTrigger(t, 'google_calendar', 'google_calendar.new_event')),
        airtable: triggers.filter((t) => isPollTrigger(t, 'airtable', 'airtable.new_record')),
      };
      if (Object.values(polls).every((arr) => arr.length === 0)) continue;

      const connected = (await db
        .select()
        .from(tenantSchema.workflowIntegrations)
        .where(
          and(
            eq(tenantSchema.workflowIntegrations.status, 'connected'),
            isNull(tenantSchema.workflowIntegrations.deletedAt),
          ),
        )) as unknown as IntegrationRow[];

      const pick = (type: string, integrationId?: string) =>
        integrationId
          ? connected.find((i) => i.id === integrationId && i.type === type)
          : connected.find((i) => i.type === type);

      const dispatch = (integrationId: string, provider: string, event: string, data: Record<string, unknown>) =>
        matchAndDispatchIntegrationTriggers({ env, db, workspaceId: clerkOrgId, userId: 'system', provider, event, integrationId, data });

      const saveSettings = (integration: IntegrationRow, settings: Record<string, unknown>) =>
        db
          .update(tenantSchema.workflowIntegrations)
          .set({ settings, updatedAt: new Date() })
          .where(eq(tenantSchema.workflowIntegrations.id, integration.id));

      // --- Google Sheets: diff row count per watched sheet ---
      for (const t of polls.google_sheets) {
        const spreadsheetId = triggerField(t, 'spreadsheetId');
        if (!spreadsheetId) continue;
        const sheetName = triggerField(t, 'sheetName') ?? 'Sheet1';
        const integration = pick('google_sheets', triggerIntegrationId(t));
        if (!integration) continue;
        const token = await resolveGoogleToken(env, db, integration);
        if (!token) continue;

        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) continue;
        const rows = ((await res.json()) as { values?: unknown[][] }).values ?? [];
        const settings = (integration.settings as Record<string, any>) || {};
        const cursors: Record<string, number> = settings.sheetsCursors || {};
        const cursorKey = `${spreadsheetId}!${sheetName}`;
        const prev = cursors[cursorKey];
        if (prev === undefined) {
          cursors[cursorKey] = rows.length;
        } else if (rows.length > prev) {
          for (let i = prev; i < rows.length; i++) {
            await dispatch(integration.id, 'google_sheets', 'google_sheets.new_row', { rowNumber: i + 1, values: rows[i] ?? [] });
            dispatched++;
          }
          cursors[cursorKey] = rows.length;
        }
        if (cursors[cursorKey] !== prev) {
          integration.settings = { ...settings, sheetsCursors: cursors };
          await saveSettings(integration, integration.settings);
        }
      }

      // --- Gmail: dispatch inbox messages newer than the last seen timestamp ---
      for (const t of polls.gmail) {
        const integration = pick('gmail', triggerIntegrationId(t));
        if (!integration) continue;
        const token = await resolveGoogleToken(env, db, integration);
        if (!token) continue;
        const query = triggerField(t, 'query') ?? 'newer_than:1d';
        const settings = (integration.settings as Record<string, any>) || {};
        let lastTs = Number(settings.gmailLastTs ?? 0);
        let maxTs = lastTs;

        const listRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&labelIds=INBOX&q=${encodeURIComponent(query)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!listRes.ok) continue;
        const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
        for (const m of list.messages ?? []) {
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!msgRes.ok) continue;
          const msg = (await msgRes.json()) as {
            id: string; threadId: string; internalDate?: string; snippet?: string;
            payload?: { headers?: Array<{ name: string; value: string }> };
          };
          const ts = Number(msg.internalDate ?? 0);
          if (ts > maxTs) maxTs = ts;
          if (lastTs !== 0 && ts > lastTs) {
            const header = (n: string) => msg.payload?.headers?.find((h) => h.name === n)?.value;
            await dispatch(integration.id, 'gmail', 'gmail.new_email', {
              id: msg.id, threadId: msg.threadId, from: header('From'), subject: header('Subject'), snippet: msg.snippet,
            });
            dispatched++;
          }
        }
        if (maxTs !== lastTs) {
          integration.settings = { ...settings, gmailLastTs: maxTs };
          await saveSettings(integration, integration.settings);
        }
      }

      // --- Google Calendar: dispatch upcoming events created since last seen ---
      for (const t of polls.google_calendar) {
        const integration = pick('google_calendar', triggerIntegrationId(t));
        if (!integration) continue;
        const token = await resolveGoogleToken(env, db, integration);
        if (!token) continue;
        const calendarId = triggerField(t, 'calendarId') ?? 'primary';
        const settings = (integration.settings as Record<string, any>) || {};
        let lastCreated = settings.calendarLastCreated ? Date.parse(settings.calendarLastCreated) : 0;
        let maxCreated = lastCreated;

        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(new Date().toISOString())}&singleEvents=true&orderBy=startTime&maxResults=10`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          items?: Array<{ id: string; summary?: string; start?: unknown; end?: unknown; htmlLink?: string; created?: string }>;
        };
        for (const ev of data.items ?? []) {
          const created = ev.created ? Date.parse(ev.created) : 0;
          if (created > maxCreated) maxCreated = created;
          if (lastCreated !== 0 && created > lastCreated) {
            await dispatch(integration.id, 'google_calendar', 'google_calendar.new_event', {
              id: ev.id, summary: ev.summary, start: ev.start, end: ev.end, htmlLink: ev.htmlLink,
            });
            dispatched++;
          }
        }
        if (maxCreated !== lastCreated) {
          integration.settings = { ...settings, calendarLastCreated: new Date(maxCreated).toISOString() };
          await saveSettings(integration, integration.settings);
        }
      }

      // --- Airtable: dispatch records created since last seen createdTime ---
      for (const t of polls.airtable) {
        const baseId = triggerField(t, 'baseId');
        const tableId = triggerField(t, 'tableId');
        if (!baseId || !tableId) continue;
        const integration = pick('airtable', triggerIntegrationId(t));
        if (!integration) continue;
        const token = await decryptConnectionCred(env, integration, 'token');
        if (!token) continue;
        const settings = (integration.settings as Record<string, any>) || {};
        const cursors: Record<string, string> = settings.airtableCursors || {};
        const key = `${baseId}:${tableId}`;
        const prev = cursors[key] ? Date.parse(cursors[key]) : 0;
        let maxCreated = prev;

        const res = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}?pageSize=50`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) continue;
        const data = (await res.json()) as { records?: Array<{ id: string; fields: unknown; createdTime: string }> };
        const sorted = [...(data.records ?? [])].sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime));
        for (const r of sorted) {
          const created = Date.parse(r.createdTime);
          if (created > maxCreated) maxCreated = created;
          if (prev !== 0 && created > prev) {
            await dispatch(integration.id, 'airtable', 'airtable.new_record', { id: r.id, fields: r.fields, createdTime: r.createdTime });
            dispatched++;
          }
        }
        if (maxCreated !== prev) {
          cursors[key] = new Date(maxCreated).toISOString();
          integration.settings = { ...settings, airtableCursors: cursors };
          await saveSettings(integration, integration.settings);
        }
      }
    } catch (err) {
      console.error(`[Poll] Failed for workspace ${workspace.id}:`, err);
    }
  }
  console.log(`[Poll] Done. Items dispatched: ${dispatched}`);
}

// ============ Outbound webhook delivery retry sweep (cron) ============
//
// Piggy-backs on the existing 10-minute poll cron (`INTEGRATION_POLL_CRON`) —
// a dedicated cron trigger would mean another wrangler.toml entry per
// environment, and the existing 10-minute cadence is a fine retry interval
// for the failure backoff windows `retryFailedWebhookDeliveries` computes.

async function runWebhookRetrySweep(env: Env): Promise<void> {
  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({ id: masterSchema.workspaces.id })
    .from(masterSchema.workspaces);

  let attempted = 0;
  let succeeded = 0;

  for (const workspace of workspaces) {
    try {
      const db = await getTenantDbForWorkspaceById(env, workspace.id);
      const result = await retryFailedWebhookDeliveries(db);
      attempted += result.attempted;
      succeeded += result.succeeded;
    } catch (err) {
      console.error(`[WebhookRetrySweep] Failed for workspace ${workspace.id}:`, err);
    }
  }

  if (attempted > 0) {
    console.log(`[WebhookRetrySweep] Done. Attempted: ${attempted}, Succeeded: ${succeeded}`);
  }
}

// ============ Export ============

export { CrmSyncWorkflow } from './workflows/crm-sync';
export { GithubProjectSyncWorkflow } from './workflows/github-project-sync';
export { GithubProjectOutboundSyncWorkflow } from './workflows/github-project-outbound';

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Branch by cron pattern so the Sheets poll and the (disabled) CRM auto-sync
    // stay decoupled — only the poll cron is enabled in wrangler.toml today.
    if (controller.cron === INTEGRATION_POLL_CRON) {
      ctx.waitUntil(runIntegrationPolls(env));
      ctx.waitUntil(runWebhookRetrySweep(env));
    } else {
      ctx.waitUntil(runScheduledSync(env));
    }
  },
} satisfies ExportedHandler<Env>;
