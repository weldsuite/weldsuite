/**
 * WeldSuite Integration Webhook Worker
 *
 * Dedicated Cloudflare Worker that receives webhooks from external integration
 * providers (Attio, HubSpot, Salesforce, etc.), verifies signatures, fetches
 * full records, and upserts into tenant databases.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { logger } from 'hono/logger';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspaceById, getTenantDbForWorkspace, tenantSchema, masterSchema, type TenantDatabase } from './db';
import { fetchConnectInternal, hasConnectInternal } from './lib/connect-internal';
import { getProvider } from './lib/integrations/registry';
import type {
  ExternalRecord,
  GenericExternalEntity,
  IntegrationProvider,
  ParsedWebhookEvent,
} from './lib/integrations/types';
import { upsertCompany, upsertPerson, softDeleteByMapping, resolveCompanyByExternalId, resolveEntityByExternalId, upsertNote, softDeleteNote, upsertTask, softDeleteTask, upsertListAndEntry, softDeleteListEntry } from './lib/sync';
import { getValidAccessToken } from './lib/token';
import { encryptField, maybeDecryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import {
  publishEntityEventRaw,
  matchAndDispatchIntegrationTriggers,
  retryFailedWebhookDeliveries,
  hasPendingWebhookRetries,
  type EntityEventMessage,
} from '@weldsuite/entity-events';
import { handleEntityWebhookBatch } from './entity-webhooks-consumer';
import {
  listDueTenantWorkIndex,
  markTenantWorkIndexRan,
  upsertTenantWorkIndex,
  TENANT_WORK_INTERVAL_MS,
  triggersIncludeWorkflowPoll,
  type TenantWorkIndexDb,
} from '@weldsuite/connectors';
import {
  verifySlackSignature,
  parseSlackEventCallback,
  parseSlackSlashCommand,
  type ParsedSlackEvent,
} from './lib/workflow-events/slack';
import { verifyTwilioSignature, parseTwilioSms } from './lib/workflow-events/twilio';
import { verifyGithubSignature, parseGithubEvent } from './lib/workflow-events/github';
import { githubAppWebhookRoutes } from './github/webhook';
import { bankFeedWebhookRoutes } from './bank-feeds/webhook';
import type { BankFeedEnv } from '@weldsuite/bank-feeds';
import type { OAuthTokens } from '@weldsuite/db/schema';

const WORKFLOW_POLL_INTERVAL_MS = TENANT_WORK_INTERVAL_MS;
const WEBHOOK_RETRY_INTERVAL_MS = TENANT_WORK_INTERVAL_MS;

// ============ Env interface ============

export interface Env extends BankFeedEnv {
  HYPERDRIVE_MASTER: Hyperdrive;
  DATABASE_URL_MASTER?: string;
  WORKSPACE_CACHE: KVNamespace;
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  ENVIRONMENT: string;
  /** connect-api `ConnectInternal` entrypoint (weldsuite-connect-api[-test]) —
   *  connector-event ingest, Meta ad events, Google Calendar incremental-sync
   *  trigger + watch-channel renewal, via connect-api's internal integration
   *  routes. Trusted by topology (no secret). */
  CONNECT_INTERNAL?: Fetcher;
  /** app-api service binding (weldsuite-app-api[-test]) — the public
   *  /webhooks/woocommerce/auth compat forward, and the FALLBACK path to the
   *  internal integration routes (through app-api's forwarder) while
   *  CONNECT_INTERNAL is unbound or the entrypoint is not deployed yet. */
  APP_API?: Fetcher;
  /**
   * Fallback path only: must match the target env's INTERNAL_API_SECRET — the
   * public internal integrations router fails closed with 401 on a missing/wrong
   * secret, and the callers below only log. Unused once CONNECT_INTERNAL is
   * bound everywhere.
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
  /** books-api `BooksInternal` entrypoint (weldsuite-books-api[-test]): verified bank feed
   *  events (POST /webhooks/bank-feeds/:provider) are forwarded to /internal/bank-connections/events.
   *  Trusted by topology (no secret). Provider keys for Plaid's webhook-key fetch are PLAID_CLIENT_ID /
   *  PLAID_SECRET / PLAID_ENV (BankFeedEnv). */
  BOOKS_INTERNAL?: Fetcher;
  /** Stripe Financial Connections webhook signing secret (its own endpoint, not billing's). */
  STRIPE_FC_WEBHOOK_SECRET?: string;
  /** Meta Marketing API — WeldAds webhook verification + signature checks. */
  FACEBOOK_APP_SECRET?: string;
  FACEBOOK_WEBHOOK_VERIFY_TOKEN?: string;
  /** Slack app signing secret — verifies inbound Slack webhooks. */
  SLACK_SIGNING_SECRET?: string;
  /** Google OAuth client — refreshes expired Sheets/Workspace tokens during the poll. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Shared D1 with integration-sync-worker / app-api — CRM due rows + tenant
   * work queue (workflow polls, webhook retries). Quiet ticks never fan out
   * every Neon.
   */
  CONNECTOR_SYNC_INDEX?: D1Database;
  /** OAuth client credentials for refreshing expired provider tokens. */
  ATTIO_CLIENT_ID?: string;
  ATTIO_CLIENT_SECRET?: string;
  HUBSPOT_CLIENT_ID?: string;
  HUBSPOT_CLIENT_SECRET?: string;
  // Entity-event hub (publishEntityEventRaw). Optional — the publisher
  // no-ops + warns when the binding is absent. Hub fans out to audit /
  // analytics / search / webhooks (Phase 2–3).
  ENTITY_EVENTS?: Queue;
  REALTIME?: Fetcher;
}

/** Providers eligible for scheduled auto-sync (cron). Ecommerce connectors
 *  (WooCommerce, Shopify) are webhook-only and must not be added here. */
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

// Bank feed provider webhooks (Plaid, Stripe Financial Connections) → POST /webhooks/bank-feeds/:provider
app.route('/webhooks', bankFeedWebhookRoutes());

/**
 * WooCommerce application authentication callback (compat). Canonical receiver
 * is app-api `POST /webhooks/woocommerce/auth`. This path forwards so older
 * authorize URLs that still pointed at this worker keep working.
 */
app.post('/webhooks/woocommerce/auth', async (c) => {
  const rawBody = await c.req.text();
  if (!c.env.APP_API) {
    console.error('[Webhook/woocommerce-auth] APP_API binding missing');
    return c.json({ error: 'WooCommerce auth ingest unavailable' }, 503);
  }

  const res = await c.env.APP_API.fetch(
    new Request('https://internal/webhooks/woocommerce/auth', {
      method: 'POST',
      headers: { 'Content-Type': c.req.header('content-type') || 'application/json' },
      body: rawBody,
    }),
  );

  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
  });
});

/**
 * WooCommerce / Shopify push webhooks. KV tells us which tenant; ingest happens
 * in app-api so this worker never opens a tenant database on a timer.
 */
app.post('/webhooks/connectors/:connectionId', async (c) => {
  const connectionId = c.req.param('connectionId');
  const cached = await c.env.WORKSPACE_CACHE.get(`connconn:${connectionId}`);
  if (!cached) {
    return c.json({ error: 'Unknown connector' }, 404);
  }

  let entry: { workspaceId: string; provider: string };
  try {
    entry = JSON.parse(cached) as { workspaceId: string; provider: string };
  } catch {
    return c.json({ error: 'Corrupt connector mapping' }, 500);
  }

  if (!hasConnectInternal(c.env)) {
    console.error('[Webhook/connectors] CONNECT_INTERNAL / APP_API binding missing');
    return c.json({ error: 'Connector ingest unavailable' }, 503);
  }

  const rawBody = await c.req.text();
  const headers = new Headers({
    'Content-Type': c.req.header('content-type') || 'application/json',
    'X-Internal-Workspace-Id': entry.workspaceId,
  });
  for (const name of [
    'x-wc-webhook-topic',
    'x-wc-webhook-signature',
    'x-shopify-topic',
    'x-shopify-hmac-sha256',
    'moneybird-signature',
    'x-picqer-signature',
    'idempotency-key',
  ]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }

  const res = await fetchConnectInternal(
    c.env,
    `/api/integrations/connections/${connectionId}/connector-event`,
    { method: 'POST', headers, body: rawBody },
  );

  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
  });
});

/**
 * Meta Marketing API webhooks for WeldAds. KV resolves the tenant; app-api opens
 * the tenant DB only for incremental ingest of the changed campaign/account.
 */
app.get('/webhooks/meta/ads', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  const expected = c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || 'weldsuite-meta-ads';
  if (mode === 'subscribe' && token === expected && challenge) {
    return c.text(challenge);
  }
  return c.text('Forbidden', 403);
});

app.post('/webhooks/meta/ads', async (c) => {
  if (!hasConnectInternal(c.env)) {
    console.error('[Webhook/meta/ads] CONNECT_INTERNAL / APP_API binding missing');
    return c.json({ error: 'Ad ingest unavailable' }, 503);
  }

  const rawBody = await c.req.text();
  const { verifyMetaWebhookSignature, parseMetaAdsWebhook } = await import('@weldsuite/meta-ads');
  const appSecret = c.env.FACEBOOK_APP_SECRET;
  if (appSecret) {
    const valid = await verifyMetaWebhookSignature(rawBody, c.req.header('X-Hub-Signature-256'), appSecret);
    if (!valid) return c.json({ error: 'Invalid signature' }, 401);
  }

  let payload: Parameters<typeof parseMetaAdsWebhook>[0];
  try {
    payload = JSON.parse(rawBody) as Parameters<typeof parseMetaAdsWebhook>[0];
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const events = parseMetaAdsWebhook(payload);
  const responses = [];

  for (const event of events) {
    const cached = await c.env.WORKSPACE_CACHE.get(`adsconn:${event.platformAccountId}`);
    if (!cached) {
      responses.push({ skipped: true, platformAccountId: event.platformAccountId });
      continue;
    }

    let entry: { workspaceId: string; connectionId: string; clerkOrgId: string };
    try {
      entry = JSON.parse(cached) as { workspaceId: string; connectionId: string; clerkOrgId: string };
    } catch {
      responses.push({ error: 'Corrupt ad account mapping', platformAccountId: event.platformAccountId });
      continue;
    }

    const res = await fetchConnectInternal(c.env, '/api/integrations/ad-events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workspace-Id': entry.clerkOrgId,
      },
      body: JSON.stringify({
        platformAccountId: event.platformAccountId,
        platformCampaignId: event.objectId,
        objectType: event.objectType,
      }),
    });
    responses.push({ platformAccountId: event.platformAccountId, status: res.status });
  }

  return c.json({ data: { processed: responses.length, responses } });
});

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

function decryptConnectionCred(
  env: Env,
  integration: { credentials: Record<string, unknown> | null },
  field: string,
): Promise<string | undefined> {
  const raw = (integration.credentials as Record<string, string> | null)?.[field];
  if (!raw) return Promise.resolve(undefined);
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

// ============ Shared webhook helpers ============

/** Thrown by webhook helpers to short-circuit the handler with a specific HTTP status. */
class WebhookHttpError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.status = status;
  }
}

function lowercaseHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return headers;
}

async function loadIntegrationConnection(tenantDb: TenantDatabase, connectionId: string) {
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
  return connection;
}

/** Verifies the provider signature when the connection has a webhook secret; throws 401 when invalid. */
async function assertValidWebhookSignature(
  provider: IntegrationProvider,
  rawBody: string,
  req: Request,
  webhookSecret: string | null,
  invalidMessage: string,
): Promise<void> {
  if (!webhookSecret) return;
  const valid = await provider.verifyWebhookSignature(rawBody, lowercaseHeaders(req), webhookSecret);
  if (!valid) {
    console.warn(invalidMessage);
    throw new WebhookHttpError(401, 'Invalid signature');
  }
}

// ============ HubSpot webhook handler (single URL for all portals) ============

interface HubspotConnectionTarget {
  workspaceId: string;
  connectionId: string;
}

/** Scans every workspace for the connection that owns this HubSpot portal and caches the hit in KV. */
async function scanWorkspacesForHubspotPortal(
  env: Env,
  portalId: number,
  cacheKey: string,
): Promise<HubspotConnectionTarget | null> {
  // (master `workspaces` has no soft-delete column — no deletedAt filter.)
  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({ id: masterSchema.workspaces.id })
    .from(masterSchema.workspaces);

  let found: HubspotConnectionTarget | null = null;
  for (const ws of workspaces) {
    try {
      const db = await getTenantDbForWorkspaceById(env, ws.id);
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
        found = { workspaceId: ws.id, connectionId: conn.id };
        // Cache for next time
        await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(found), { expirationTtl: 86400 * 30 });
        break;
      }
    } catch { /* skip workspace */ }
  }
  return found;
}

/** Finds the connection for a HubSpot portal: KV cache first, then a scan of all workspaces. */
async function findHubspotConnectionByPortal(
  env: Env,
  portalId: number,
  cacheKey: string,
): Promise<HubspotConnectionTarget | null> {
  const cached = await env.WORKSPACE_CACHE.get(cacheKey, 'json') as HubspotConnectionTarget | null;
  if (cached) return { workspaceId: cached.workspaceId, connectionId: cached.connectionId };
  return scanWorkspacesForHubspotPortal(env, portalId, cacheKey);
}

/** HubSpot nests the record fields under `properties`; fall back to the flat entity data. */
function hubspotRecordData(entity: GenericExternalEntity): Record<string, unknown> {
  const properties = entity.data.properties as Record<string, unknown> | undefined;
  return properties || entity.data;
}

/** Processes one HubSpot event; returns true when it was applied. */
async function processHubspotEvent(
  env: Env,
  provider: IntegrationProvider,
  tenantDb: TenantDatabase,
  target: HubspotConnectionTarget,
  accessToken: string,
  event: ParsedWebhookEvent,
): Promise<boolean> {
  const { workspaceId, connectionId } = target;
  const entityType = provider.resolveEntityType?.(event);
  if (!entityType) return false;

  if (event.eventType === 'record.deleted') {
    await softDeleteByMapping(tenantDb, connectionId, event.objectType, event.recordId);
    return true;
  }

  if (!provider.fetchEntityGeneric) return false;
  const entity = await provider.fetchEntityGeneric(accessToken, entityType, event.recordId);

  if (entityType === 'company') {
    const mapped = provider.mapCompany({ id: entity.id, type: 'company', data: hubspotRecordData(entity), raw: entity.raw });
    const result = await upsertCompany(tenantDb, connectionId, 'company', entity.id, mapped, entity.raw);
    await emitCrmEvent(env, tenantDb, workspaceId, 'company', result.action, result.companyId, mapped.data as Record<string, unknown>);
  } else if (entityType === 'person') {
    const mapped = provider.mapPerson({ id: entity.id, type: 'person', data: hubspotRecordData(entity), raw: entity.raw });
    const result = await upsertPerson(tenantDb, connectionId, entity.id, mapped, undefined, entity.raw);
    await emitCrmEvent(env, tenantDb, workspaceId, 'person', result.action, result.personId, mapped.data as Record<string, unknown>);
  }
  return true;
}

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
    const target = await findHubspotConnectionByPortal(c.env, portalId, cacheKey);
    if (!target) {
      console.warn(`[Webhook/HubSpot] No connection for portalId: ${portalId}`);
      return c.json({ error: 'Portal not connected' }, 404);
    }
    const { workspaceId, connectionId } = target;

    // 3. Load connection from tenant DB
    const provider = getProvider('hubspot');
    if (!provider) return c.json({ error: 'HubSpot provider not registered' }, 500);

    const tenantDb = await getTenantDbForWorkspaceById(c.env, workspaceId);
    const connection = await loadIntegrationConnection(tenantDb, connectionId);

    if (!connection) {
      // Invalidate stale cache
      await c.env.WORKSPACE_CACHE.delete(cacheKey);
      return c.json({ error: 'Connection not found' }, 404);
    }

    // 4. Verify signature
    await assertValidWebhookSignature(
      provider,
      rawBody,
      c.req.raw,
      connection.webhookSecret,
      `[Webhook/HubSpot] Invalid signature for portal ${portalId}`,
    );

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
        if (await processHubspotEvent(c.env, provider, tenantDb, target, accessToken, event)) processed++;
      } catch (err) {
        console.error(`[Webhook/HubSpot] Failed to process event ${event.recordId}:`, err);
      }
    }

    console.info(`[Webhook/HubSpot] Processed ${processed}/${payload.events.length} events`);
    return c.json({ received: true, processed });
  } catch (err) {
    if (err instanceof WebhookHttpError) return c.json({ error: err.message }, err.status);
    console.error('[Webhook/HubSpot] Handler error:', err);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ============ Google Calendar push notification handler ============

/** Checks the `X-Goog-Channel-Token` against the stored watch token; an unparsable secret is tolerated. */
function isValidGcalChannelToken(
  webhookSecret: string | null,
  channelToken: string | undefined,
  connectionId: string,
): boolean {
  if (!webhookSecret || !channelToken) return true;
  try {
    const parsed = JSON.parse(webhookSecret) as { token: string };
    if (parsed.token !== channelToken) {
      console.warn(`[Webhook/GoogleCalendar] Invalid channel token for ${connectionId}`);
      return false;
    }
  } catch {
    console.warn(`[Webhook/GoogleCalendar] Failed to parse webhookSecret for ${connectionId}`);
  }
  return true;
}

/** Triggers an incremental sync through connect-api's internal integration routes. */
async function triggerGcalIncrementalSync(env: Env, connectionId: string, workspaceId: string): Promise<void> {
  console.info(`[Webhook/GoogleCalendar] Change notification for ${connectionId}, triggering incremental sync`);

  if (!hasConnectInternal(env)) {
    console.warn('[Webhook/GoogleCalendar] CONNECT_INTERNAL / APP_API service binding not available');
    return;
  }

  // Trigger sync on connect-api's internal integration routes via the
  // ConnectInternal entrypoint (no secret). The fallback path through
  // app-api's forwarder sends X-Internal-Secret, which that router
  // requires (401 otherwise; the !ok branch only logs and still 200s to
  // Google).
  const syncResponse = await fetchConnectInternal(
    env,
    '/api/integrations/connections/' + connectionId + '/sync',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Workspace-Id': workspaceId,
      },
      body: JSON.stringify({ syncType: 'incremental' }),
    },
  );
  if (!syncResponse.ok) {
    console.error(`[Webhook/GoogleCalendar] Sync trigger failed: ${syncResponse.status}`);
  }
}

app.post('/webhook/gcal/:connectionId', async (c) => {
  const { connectionId } = c.req.param();

  try {
    // Extract Google-specific headers
    const headers = lowercaseHeaders(c.req.raw);

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
    const connection = await loadIntegrationConnection(tenantDb, connectionId);

    if (!connection) {
      return c.json({ error: 'Connection not found' }, 404);
    }

    if (!isValidGcalChannelToken(connection.webhookSecret, channelToken, connectionId)) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    // Trigger incremental sync via CRM_SYNC workflow
    if (resourceState === 'exists') {
      await triggerGcalIncrementalSync(c.env, connectionId, kvEntry.workspaceId);
    }

    return c.json({ status: 'ok', type: 'sync_triggered' });
  } catch (err) {
    console.error('[Webhook/GoogleCalendar] Handler error:', err);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ============ Per-connection webhook handler (Attio, etc.) ============

interface AttioEventContext {
  env: Env;
  tenantDb: TenantDatabase;
  provider: IntegrationProvider;
  accessToken: string;
  connectionId: string;
  workspaceId: string;
}

interface AttioSyncCounters {
  companies: number;
  people: number;
  tasks: number;
  listEntries: number;
}

// ---- Note events ----
async function handleAttioNoteEvent(ctx: AttioEventContext, event: ParsedWebhookEvent): Promise<void> {
  const { tenantDb, provider, accessToken, connectionId } = ctx;
  console.info(`[Webhook] Processing note event: ${event.eventType} noteId=${event.noteId}`);

  if (event.eventType === 'note.deleted') {
    if (event.noteId) {
      const deleted = await softDeleteNote(tenantDb, connectionId, event.noteId);
      console.info(`[Webhook] Note soft-deleted: ${event.noteId} (found=${deleted})`);
    }
    return;
  }

  // note.created / note.updated — fetch full note and upsert
  if (!event.noteId) {
    console.warn(`[Webhook] Note event missing noteId, skipping`);
    return;
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
}

// ---- Task events ---- (returns true when a task was upserted)
async function handleAttioTaskEvent(ctx: AttioEventContext, event: ParsedWebhookEvent): Promise<boolean> {
  const { tenantDb, provider, accessToken, connectionId } = ctx;
  console.info(`[Webhook] Processing task event: ${event.eventType} taskId=${event.taskId}`);

  if (event.eventType === 'task.deleted') {
    if (event.taskId) {
      const deleted = await softDeleteTask(tenantDb, connectionId, event.taskId);
      console.info(`[Webhook] Task soft-deleted: ${event.taskId} (found=${deleted})`);
    }
    return false;
  }

  // task.created / task.updated — fetch full task and upsert
  if (!event.taskId) {
    console.warn(`[Webhook] Task event missing taskId, skipping`);
    return false;
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
  return true;
}

// ---- List-entry events ---- (returns true when a list entry was upserted)
async function handleAttioListEntryEvent(ctx: AttioEventContext, event: ParsedWebhookEvent): Promise<boolean> {
  const { tenantDb, provider, accessToken, connectionId } = ctx;
  console.info(`[Webhook] Processing list-entry event: ${event.eventType} entryId=${event.listEntryId} listId=${event.listId}`);

  if (event.eventType === 'list-entry.deleted') {
    if (event.listEntryId) {
      const deleted = await softDeleteListEntry(tenantDb, connectionId, event.listEntryId);
      console.info(`[Webhook] List entry deleted: ${event.listEntryId} (found=${deleted})`);
    }
    return false;
  }

  // list-entry.created / list-entry.updated
  if (!event.listEntryId || !event.listId) {
    console.warn(`[Webhook] List-entry event missing entryId or listId, skipping`);
    return false;
  }

  const listEntry = await provider.fetchListEntry(accessToken, event.listId, event.listEntryId);

  // Resolve parent record to a WeldSuite customer
  const resolvedParent = await resolveEntityByExternalId(
    tenantDb, connectionId, listEntry.parentRecordId
  );
  if (resolvedParent?.internalEntityType !== 'company') {
    console.warn(`[Webhook] List entry parent record not found or not a company: ${listEntry.parentRecordId}`);
    return false;
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
  return true;
}

async function upsertAttioCompany(ctx: AttioEventContext, record: ExternalRecord): Promise<void> {
  const { env, tenantDb, provider, connectionId, workspaceId } = ctx;
  const mapped = provider.mapCompany(record);
  const result = await upsertCompany(
    tenantDb, connectionId, 'company', record.id, mapped, record.raw
  );
  console.info(`[Webhook] Company ${result.action}: ${result.companyId}`);
  await emitCrmEvent(env, tenantDb, workspaceId, 'company', result.action, result.companyId, mapped.data as Record<string, unknown>);
}

async function upsertAttioPerson(ctx: AttioEventContext, record: ExternalRecord): Promise<void> {
  const { env, tenantDb, provider, connectionId, workspaceId } = ctx;
  const mapped = provider.mapPerson(record);
  const parentCompanyId = mapped.parentCompanyExternalId
    ? await resolveCompanyByExternalId(tenantDb, connectionId, mapped.parentCompanyExternalId)
    : undefined;
  const result = await upsertPerson(
    tenantDb, connectionId, record.id, mapped, parentCompanyId, record.raw
  );
  console.info(`[Webhook] Person ${result.action}: ${result.personId} (parentCompany=${parentCompanyId ?? 'none'})`);
  await emitCrmEvent(env, tenantDb, workspaceId, 'person', result.action, result.personId, mapped.data as Record<string, unknown>);
}

// ---- Record events ---- (returns which kind of record was upserted, if any)
async function handleAttioRecordEvent(
  ctx: AttioEventContext,
  event: ParsedWebhookEvent,
): Promise<'company' | 'person' | null> {
  const { tenantDb, provider, accessToken, connectionId } = ctx;

  // Resolve object UUID to slug (e.g., "people", "companies")
  const objectType = await provider.resolveObjectSlug(accessToken, event.objectId);
  console.info(`[Webhook] Processing: ${event.eventType} ${objectType} (${event.objectId}) record=${event.recordId}`);

  const externalType = objectType === 'companies' ? 'company' : 'person';

  if (event.eventType === 'record.deleted') {
    // Soft-delete
    await softDeleteByMapping(tenantDb, connectionId, externalType, event.recordId);
    console.info(`[Webhook] Soft-deleted ${externalType} ${event.recordId}`);
    return null;
  }

  // Create/update/merge — fetch full record and upsert
  const record = await provider.fetchRecord(accessToken, objectType, event.recordId);

  if (objectType === 'companies') {
    await upsertAttioCompany(ctx, record);
  } else if (objectType === 'people') {
    await upsertAttioPerson(ctx, record);
  } else {
    console.warn(`[Webhook] Skipping unknown object type: ${objectType}`);
    return null;
  }

  // For merge events, also soft-delete the merged-from record
  if (event.eventType === 'record.merged' && event.mergedFromId) {
    await softDeleteByMapping(tenantDb, connectionId, externalType, event.mergedFromId);
    console.info(`[Webhook] Soft-deleted merged-from ${externalType} ${event.mergedFromId}`);
  }
  return externalType;
}

async function processAttioEvent(
  ctx: AttioEventContext,
  event: ParsedWebhookEvent,
  counters: AttioSyncCounters,
): Promise<void> {
  if (event.eventType.startsWith('note.')) {
    await handleAttioNoteEvent(ctx, event);
    return;
  }
  if (event.eventType.startsWith('task.')) {
    if (await handleAttioTaskEvent(ctx, event)) counters.tasks++;
    return;
  }
  if (event.eventType.startsWith('list-entry.')) {
    if (await handleAttioListEntryEvent(ctx, event)) counters.listEntries++;
    return;
  }

  const recordKind = await handleAttioRecordEvent(ctx, event);
  if (recordKind === 'company') counters.companies++;
  else if (recordKind === 'person') counters.people++;
}

/** Adds the processed counts to the connection's running sync totals. */
async function updateAttioConnectionStats(
  tenantDb: TenantDatabase,
  connectionId: string,
  counters: AttioSyncCounters,
): Promise<void> {
  const connections = tenantSchema.integrationConnections;
  const increments = [
    { key: 'companiesSynced', count: counters.companies, column: connections.companiesSynced },
    { key: 'peopleSynced', count: counters.people, column: connections.peopleSynced },
    { key: 'tasksSynced', count: counters.tasks, column: connections.tasksSynced },
    { key: 'listsSynced', count: counters.listEntries, column: connections.listsSynced },
  ].filter((inc) => inc.count > 0);
  if (increments.length === 0) return;

  const statsUpdate: Record<string, unknown> = { updatedAt: new Date() };
  for (const { key, count, column } of increments) {
    statsUpdate[key] = sql`${column} + ${count}`;
  }
  await tenantDb
    .update(connections)
    .set(statsUpdate)
    .where(eq(connections.id, connectionId));
}

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
    const connection = await loadIntegrationConnection(tenantDb, connectionId);

    if (!connection) {
      console.warn(`[Webhook] Connection not found in DB: ${connectionId}`);
      return c.json({ error: 'Connection not found' }, 404);
    }

    // 4. Verify webhook signature
    await assertValidWebhookSignature(
      provider,
      rawBody,
      c.req.raw,
      connection.webhookSecret,
      `[Webhook] Invalid signature for connection: ${connectionId}`,
    );

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
    const ctx: AttioEventContext = { env: c.env, tenantDb, provider, accessToken, connectionId, workspaceId };
    const counters: AttioSyncCounters = { companies: 0, people: 0, tasks: 0, listEntries: 0 };

    for (const event of payload.events) {
      await processAttioEvent(ctx, event, counters);
    }

    // 8. Update connection stats
    await updateAttioConnectionStats(tenantDb, connectionId, counters);

    return c.json({ status: 'ok', processed: payload.events.length });
  } catch (err) {
    if (err instanceof WebhookHttpError) return c.json({ error: err.message }, err.status);
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

type IntegrationConnectionRow = typeof tenantSchema.integrationConnections.$inferSelect;

interface CronSyncCounters {
  triggered: number;
  skipped: number;
}

/** True when the connection's last sync is older than its (clamped) sync interval. */
function isConnectionSyncDue(connection: IntegrationConnectionRow, now: number): boolean {
  const syncSettings = connection.syncSettings as CronSyncSettings | null;
  const intervalHours = Math.max(
    syncSettings?.syncIntervalHours || DEFAULT_SYNC_INTERVAL_HOURS,
    MIN_SYNC_INTERVAL_HOURS,
  );
  const lastSync = connection.lastSyncAt ? new Date(connection.lastSyncAt).getTime() : 0;
  const dueAt = lastSync + intervalHours * 60 * 60 * 1000;
  // An unparseable lastSyncAt (NaN) counts as due, as before.
  return Number.isNaN(dueAt) || now >= dueAt;
}

/** Google Calendar watch-channel renewal via connect-api's internal router. */
async function renewGoogleWatchIfExpiring(
  env: Env,
  connection: IntegrationConnectionRow,
  clerkOrgId: string,
  now: number,
): Promise<void> {
  if (connection.provider !== 'google_calendar' || !connection.webhookSecret || !hasConnectInternal(env)) return;
  try {
    const watchInfo = JSON.parse(connection.webhookSecret) as { expiration?: string };
    if (!watchInfo.expiration) return;
    const expiresAt = Number(watchInfo.expiration);
    if (now > expiresAt - 24 * 60 * 60 * 1000) {
      await fetchConnectInternal(
        env,
        `/api/integrations/connections/${connection.id}/renew-watch`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Workspace-Id': clerkOrgId,
          },
        },
      );
    }
  } catch (err) {
    console.error(`[IntegrationScheduler] Watch renewal check failed for ${connection.id}:`, err);
  }
}

/** Starts the incremental sync Workflow for one connection; returns true when it was triggered. */
async function triggerConnectionSync(
  env: Env,
  db: TenantDatabase,
  connection: IntegrationConnectionRow,
  clerkOrgId: string,
): Promise<boolean> {
  try {
    // Trigger the sync Workflow directly — the engine lives in this worker.
    await env.CRM_SYNC.create({
      params: {
        workspaceId: clerkOrgId,
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
    return true;
  } catch (err) {
    console.error(`[IntegrationScheduler] Failed to trigger sync for ${connection.id}:`, err);
    return false;
  }
}

async function syncWorkspaceConnections(
  env: Env,
  workspace: { id: string; clerkOrgId: string },
  now: number,
  counters: CronSyncCounters,
): Promise<void> {
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

    if (!isConnectionSyncDue(connection, now)) {
      counters.skipped++;
      continue;
    }

    await renewGoogleWatchIfExpiring(env, connection, workspace.clerkOrgId, now);

    if (await triggerConnectionSync(env, db, connection, workspace.clerkOrgId)) counters.triggered++;
  }
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

  const counters: CronSyncCounters = { triggered: 0, skipped: 0 };
  const now = Date.now();

  for (const workspace of workspaces) {
    if (!workspace.clerkOrgId) continue;
    try {
      await syncWorkspaceConnections(env, { id: workspace.id, clerkOrgId: workspace.clerkOrgId }, now, counters);
    } catch (err) {
      console.error(`[IntegrationScheduler] Failed to process workspace ${workspace.id}:`, err);
    }
  }

  console.log(`[IntegrationScheduler] Done. Triggered: ${counters.triggered}, Skipped (not due): ${counters.skipped}`);
}

// ============ Integration poll triggers (Sheets / Gmail / Calendar / Airtable) ============

/** Cron pattern that drives the integration polls. Branched on in `scheduled`
 *  so it never co-fires the (intentionally disabled) CRM auto-sync. */
const INTEGRATION_POLL_CRON = '*/10 * * * *';

const TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

function maybeDecryptToken(value: string, keyring: EncryptionKeyring): Promise<string> {
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
/**
 * Cold-start seed: if the D1 kind has never been written, enqueue every
 * workspace once. The next cron tick opens each Neon, then drops idle ones
 * (`nextDueAt: null`) so only real poll/retry work stays. Subsequent deploys
 * skip this because disabled rows still satisfy the existence check.
 */
async function seedTenantWorkKindIfEmpty(
  d1: TenantWorkIndexDb,
  env: Env,
  kind: 'workflow_poll' | 'webhook_retry',
): Promise<number> {
  const existing = await d1
    .prepare(`SELECT 1 AS ok FROM tenant_work_index WHERE kind = ? LIMIT 1`)
    .bind(kind)
    .all<{ ok: number }>();
  if ((existing.results?.length ?? 0) > 0) return 0;

  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({ id: masterSchema.workspaces.id, clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces);
  const now = Date.now();
  let seeded = 0;
  for (const workspace of workspaces) {
    if (!workspace.clerkOrgId) continue;
    await upsertTenantWorkIndex(d1, {
      workspaceId: workspace.id,
      clerkOrgId: workspace.clerkOrgId,
      kind,
      nextDueAt: now,
      now,
    });
    seeded += 1;
  }
  console.log(`[TenantWork] Seeded ${seeded} ${kind} rows (cold start)`);
  return seeded;
}

/**
 * Poll Google Workspace / Airtable triggers for due workspaces only.
 * Workspaces without active poll triggers are dropped from the D1 index so
 * their Neon can autosuspend; write paths re-upsert when a poll trigger is
 * activated.
 */
async function runIntegrationPolls(env: Env): Promise<void> {
  if (!env.EXECUTE_WORKFLOW) {
    console.warn('[Poll] EXECUTE_WORKFLOW binding absent — skipping');
    return;
  }
  if (!env.CONNECTOR_SYNC_INDEX) {
    console.warn('[Poll] CONNECTOR_SYNC_INDEX binding absent — skipping');
    return;
  }

  console.log(`[Poll] Starting (${env.ENVIRONMENT})`);
  const d1 = env.CONNECTOR_SYNC_INDEX;
  await seedTenantWorkKindIfEmpty(d1, env, 'workflow_poll');

  const due = await listDueTenantWorkIndex(d1, 'workflow_poll');
  let dispatched = 0;
  let kept = 0;
  let dropped = 0;

  for (const row of due) {
    const now = Date.now();
    try {
      const result = await pollWorkspaceIntegrations(env, row.workspace_id, row.clerk_org_id);
      dispatched += result.dispatched;
      if (result.hasPollTriggers) {
        kept += 1;
        await markTenantWorkIndexRan(d1, {
          workspaceId: row.workspace_id,
          kind: 'workflow_poll',
          nextDueAt: now + WORKFLOW_POLL_INTERVAL_MS,
          now,
        });
      } else {
        dropped += 1;
        await markTenantWorkIndexRan(d1, {
          workspaceId: row.workspace_id,
          kind: 'workflow_poll',
          nextDueAt: null,
          now,
        });
      }
    } catch (err) {
      console.error(`[Poll] Failed for workspace ${row.workspace_id}:`, err);
      // Keep a short backoff so a transient Neon error does not permanently
      // drop a workspace that may still need polling.
      await markTenantWorkIndexRan(d1, {
        workspaceId: row.workspace_id,
        kind: 'workflow_poll',
        nextDueAt: now + WORKFLOW_POLL_INTERVAL_MS,
        error: err instanceof Error ? err.message : 'poll failed',
        now,
      });
    }
  }

  console.log(
    `[Poll] Done. Workspaces: ${due.length}, Dispatched: ${dispatched}, Kept: ${kept}, Dropped idle: ${dropped}`,
  );
}

type PollBuckets = {
  google_sheets: unknown[];
  gmail: unknown[];
  google_calendar: unknown[];
  airtable: unknown[];
};

type PollDispatch = (
  integrationId: string,
  provider: string,
  event: string,
  data: Record<string, unknown>,
) => Promise<unknown>;

/** Everything a single poll trigger needs: DB, integration lookup, dispatch and settings persistence. */
interface PollDeps {
  env: Env;
  db: TenantDatabase;
  pick: (type: string, integrationId?: string) => IntegrationRow | undefined;
  dispatch: PollDispatch;
  saveSettings: (integration: IntegrationRow, settings: Record<string, unknown>) => Promise<unknown>;
}

function groupPollTriggers(triggers: unknown[]): PollBuckets {
  return {
    google_sheets: triggers.filter((t) => isPollTrigger(t, 'google_sheets', 'google_sheets.new_row')),
    gmail: triggers.filter((t) => isPollTrigger(t, 'gmail', 'gmail.new_email')),
    google_calendar: triggers.filter((t) => isPollTrigger(t, 'google_calendar', 'google_calendar.new_event')),
    airtable: triggers.filter((t) => isPollTrigger(t, 'airtable', 'airtable.new_record')),
  };
}

/** Google Sheets: diff row count per watched sheet. Returns the number of dispatched events. */
async function pollSheetsTrigger(deps: PollDeps, t: unknown): Promise<number> {
  const { env, db } = deps;
  const spreadsheetId = triggerField(t, 'spreadsheetId');
  if (!spreadsheetId) return 0;
  const sheetName = triggerField(t, 'sheetName') ?? 'Sheet1';
  const integration = deps.pick('google_sheets', triggerIntegrationId(t));
  if (!integration) return 0;
  const token = await resolveGoogleToken(env, db, integration);
  if (!token) return 0;

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return 0;
  const rows = ((await res.json()) as { values?: unknown[][] }).values ?? [];
  const settings = (integration.settings as Record<string, any>) || {};
  const cursors: Record<string, number> = settings.sheetsCursors || {};
  const cursorKey = `${spreadsheetId}!${sheetName}`;
  const prev = cursors[cursorKey];
  let dispatched = 0;
  if (prev === undefined) {
    cursors[cursorKey] = rows.length;
  } else if (rows.length > prev) {
    for (let i = prev; i < rows.length; i++) {
      await deps.dispatch(integration.id, 'google_sheets', 'google_sheets.new_row', {
        rowNumber: i + 1,
        values: rows[i] ?? [],
      });
      dispatched++;
    }
    cursors[cursorKey] = rows.length;
  }
  if (cursors[cursorKey] !== prev) {
    integration.settings = { ...settings, sheetsCursors: cursors };
    await deps.saveSettings(integration, integration.settings);
  }
  return dispatched;
}

async function pollWorkspaceIntegrations(
  env: Env,
  workspaceId: string,
  clerkOrgId: string,
): Promise<{ dispatched: number; hasPollTriggers: boolean }> {
  const db = await getTenantDbForWorkspaceById(env, workspaceId);
  const activeWorkflows = await db
    .select({ triggers: tenantSchema.workflows.triggers })
    .from(tenantSchema.workflows)
    .where(and(eq(tenantSchema.workflows.status, 'active'), isNull(tenantSchema.workflows.deletedAt)));

  const triggers = activeWorkflows.flatMap((wf) => (wf.triggers as any[]) || []);
  if (triggers.length === 0) return { dispatched: 0, hasPollTriggers: false };

  const polls = groupPollTriggers(triggers);
  const hasPollTriggers =
    triggersIncludeWorkflowPoll(triggers) ||
    Object.values(polls).some((arr) => arr.length > 0);
  if (!hasPollTriggers) return { dispatched: 0, hasPollTriggers: false };

  const connected = (await db
    .select()
    .from(tenantSchema.workflowIntegrations)
    .where(
      and(
        eq(tenantSchema.workflowIntegrations.status, 'connected'),
        isNull(tenantSchema.workflowIntegrations.deletedAt),
      ),
    )) as unknown as IntegrationRow[];

  const deps: PollDeps = {
    env,
    db,
    pick: (type, integrationId) =>
      integrationId
        ? connected.find((i) => i.id === integrationId && i.type === type)
        : connected.find((i) => i.type === type),
    dispatch: (integrationId, provider, event, data) =>
      matchAndDispatchIntegrationTriggers({
        env,
        db,
        workspaceId: clerkOrgId,
        userId: 'system',
        provider,
        event,
        integrationId,
        data,
      }),
    saveSettings: (integration, settings) =>
      db
        .update(tenantSchema.workflowIntegrations)
        .set({ settings, updatedAt: new Date() })
        .where(eq(tenantSchema.workflowIntegrations.id, integration.id)),
  };

  let dispatched = 0;

  // --- Google Sheets: diff row count per watched sheet ---
  for (const t of polls.google_sheets) {
    dispatched += await pollSheetsTrigger(deps, t);
  }

  // Continue with remaining poll providers.
  dispatched += await pollGmailCalendarAirtable(deps, polls);
  return { dispatched, hasPollTriggers: true };
}

/** Gmail: dispatch inbox messages newer than the last seen timestamp. */
async function pollGmailTrigger(deps: PollDeps, t: unknown): Promise<number> {
  const integration = deps.pick('gmail', triggerIntegrationId(t));
  if (!integration) return 0;
  const token = await resolveGoogleToken(deps.env, deps.db, integration);
  if (!token) return 0;
  const query = triggerField(t, 'query') ?? 'newer_than:1d';
  const settings = (integration.settings as Record<string, any>) || {};
  const lastTs = Number(settings.gmailLastTs ?? 0);
  let maxTs = lastTs;
  let dispatched = 0;

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&labelIds=INBOX&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listRes.ok) return 0;
  const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
  for (const m of list.messages ?? []) {
    const msg = await fetchGmailMessageMetadata(token, m.id);
    if (!msg) continue;
    const ts = Number(msg.internalDate ?? 0);
    if (ts > maxTs) maxTs = ts;
    if (lastTs !== 0 && ts > lastTs) {
      const header = (n: string) => msg.payload?.headers?.find((h) => h.name === n)?.value;
      await deps.dispatch(integration.id, 'gmail', 'gmail.new_email', {
        id: msg.id,
        threadId: msg.threadId,
        from: header('From'),
        subject: header('Subject'),
        snippet: msg.snippet,
      });
      dispatched++;
    }
  }
  if (maxTs !== lastTs) {
    integration.settings = { ...settings, gmailLastTs: maxTs };
    await deps.saveSettings(integration, integration.settings);
  }
  return dispatched;
}

interface GmailMessageMetadata {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

/** Fetches a Gmail message's From/Subject metadata; null when the request fails. */
async function fetchGmailMessageMetadata(token: string, messageId: string): Promise<GmailMessageMetadata | null> {
  const msgRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!msgRes.ok) return null;
  return (await msgRes.json()) as GmailMessageMetadata;
}

/** Google Calendar: dispatch upcoming events created since last seen. */
async function pollCalendarTrigger(deps: PollDeps, t: unknown): Promise<number> {
  const integration = deps.pick('google_calendar', triggerIntegrationId(t));
  if (!integration) return 0;
  const token = await resolveGoogleToken(deps.env, deps.db, integration);
  if (!token) return 0;
  const calendarId = triggerField(t, 'calendarId') ?? 'primary';
  const settings = (integration.settings as Record<string, any>) || {};
  const lastCreated = settings.calendarLastCreated ? Date.parse(settings.calendarLastCreated) : 0;
  let maxCreated = lastCreated;
  let dispatched = 0;

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(new Date().toISOString())}&singleEvents=true&orderBy=startTime&maxResults=10`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return 0;
  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      start?: unknown;
      end?: unknown;
      htmlLink?: string;
      created?: string;
    }>;
  };
  for (const ev of data.items ?? []) {
    const created = ev.created ? Date.parse(ev.created) : 0;
    if (created > maxCreated) maxCreated = created;
    if (lastCreated !== 0 && created > lastCreated) {
      await deps.dispatch(integration.id, 'google_calendar', 'google_calendar.new_event', {
        id: ev.id,
        summary: ev.summary,
        start: ev.start,
        end: ev.end,
        htmlLink: ev.htmlLink,
      });
      dispatched++;
    }
  }
  if (maxCreated !== lastCreated) {
    integration.settings = { ...settings, calendarLastCreated: new Date(maxCreated).toISOString() };
    await deps.saveSettings(integration, integration.settings);
  }
  return dispatched;
}

/** Airtable: dispatch records created since last seen createdTime. */
async function pollAirtableTrigger(deps: PollDeps, t: unknown): Promise<number> {
  const baseId = triggerField(t, 'baseId');
  const tableId = triggerField(t, 'tableId');
  if (!baseId || !tableId) return 0;
  const integration = deps.pick('airtable', triggerIntegrationId(t));
  if (!integration) return 0;
  const token = await decryptConnectionCred(deps.env, integration, 'token');
  if (!token) return 0;
  const settings = (integration.settings as Record<string, any>) || {};
  const cursors: Record<string, string> = settings.airtableCursors || {};
  const key = `${baseId}:${tableId}`;
  const prev = cursors[key] ? Date.parse(cursors[key]) : 0;
  let maxCreated = prev;
  let dispatched = 0;

  const res = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}?pageSize=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return 0;
  const data = (await res.json()) as {
    records?: Array<{ id: string; fields: unknown; createdTime: string }>;
  };
  const sorted = [...(data.records ?? [])].sort(
    (a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime),
  );
  for (const r of sorted) {
    const created = Date.parse(r.createdTime);
    if (created > maxCreated) maxCreated = created;
    if (prev !== 0 && created > prev) {
      await deps.dispatch(integration.id, 'airtable', 'airtable.new_record', {
        id: r.id,
        fields: r.fields,
        createdTime: r.createdTime,
      });
      dispatched++;
    }
  }
  if (maxCreated !== prev) {
    cursors[key] = new Date(maxCreated).toISOString();
    integration.settings = { ...settings, airtableCursors: cursors };
    await deps.saveSettings(integration, integration.settings);
  }
  return dispatched;
}

/** Runs the Gmail, Google Calendar and Airtable polls; returns the total dispatched events. */
async function pollGmailCalendarAirtable(deps: PollDeps, polls: PollBuckets): Promise<number> {
  let dispatched = 0;
  for (const t of polls.gmail) dispatched += await pollGmailTrigger(deps, t);
  for (const t of polls.google_calendar) dispatched += await pollCalendarTrigger(deps, t);
  for (const t of polls.airtable) dispatched += await pollAirtableTrigger(deps, t);
  return dispatched;
}

// ============ Outbound webhook delivery retry sweep (cron) ============

async function runWebhookRetrySweep(env: Env): Promise<void> {
  if (!env.CONNECTOR_SYNC_INDEX) {
    console.warn('[WebhookRetrySweep] CONNECTOR_SYNC_INDEX binding absent — skipping');
    return;
  }
  const d1 = env.CONNECTOR_SYNC_INDEX;
  await seedTenantWorkKindIfEmpty(d1, env, 'webhook_retry');

  const due = await listDueTenantWorkIndex(d1, 'webhook_retry');
  let attempted = 0;
  let succeeded = 0;
  let kept = 0;
  let dropped = 0;

  for (const row of due) {
    const now = Date.now();
    try {
      const db = await getTenantDbForWorkspaceById(env, row.workspace_id);
      const result = await retryFailedWebhookDeliveries(db);
      attempted += result.attempted;
      succeeded += result.succeeded;
      const pending = await hasPendingWebhookRetries(db);
      if (pending) {
        kept += 1;
        await markTenantWorkIndexRan(d1, {
          workspaceId: row.workspace_id,
          kind: 'webhook_retry',
          nextDueAt: now + WEBHOOK_RETRY_INTERVAL_MS,
          now,
        });
      } else {
        dropped += 1;
        await markTenantWorkIndexRan(d1, {
          workspaceId: row.workspace_id,
          kind: 'webhook_retry',
          // No remaining failed deliveries — drop so idle Neons autosuspend.
          // deliverWebhookEvent / test-webhook write paths re-upsert on failure.
          nextDueAt: null,
          now,
        });
      }
    } catch (err) {
      console.error(`[WebhookRetrySweep] Failed for workspace ${row.workspace_id}:`, err);
      await markTenantWorkIndexRan(d1, {
        workspaceId: row.workspace_id,
        kind: 'webhook_retry',
        nextDueAt: now + WEBHOOK_RETRY_INTERVAL_MS,
        error: err instanceof Error ? err.message : 'retry failed',
        now,
      });
    }
  }

  if (attempted > 0 || due.length > 0) {
    console.log(
      `[WebhookRetrySweep] Done. Workspaces: ${due.length}, Attempted: ${attempted}, Succeeded: ${succeeded}, Kept: ${kept}, Dropped idle: ${dropped}`,
    );
  }
}

// ============ Export ============

export { CrmSyncWorkflow } from './workflows/crm-sync';
export { GithubProjectSyncWorkflow } from './workflows/github-project-sync';
export { GithubProjectOutboundSyncWorkflow } from './workflows/github-project-outbound';

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<EntityEventMessage>, env: Env): Promise<void> {
    if (batch.queue.startsWith('entity-webhooks')) {
      await handleEntityWebhookBatch(batch, env);
      return;
    }
    console.warn(`[integration-webhook-worker] no consumer registered for queue "${batch.queue}"`);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    // Due-index sweeps only (D1). CRM auto-sync lives on integration-sync-worker.
    // Inbound webhooks (fetch) are unaffected.
    if (controller.cron === INTEGRATION_POLL_CRON) {
      ctx.waitUntil(runIntegrationPolls(env));
      ctx.waitUntil(runWebhookRetrySweep(env));
    } else {
      console.log(`[Cron] Ignoring unused schedule ${controller.cron}`);
    }
  },
} satisfies ExportedHandler<Env>;
