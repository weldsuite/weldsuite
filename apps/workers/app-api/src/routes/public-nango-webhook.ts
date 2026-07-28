/**
 * Nango webhook receiver — PUBLIC route, `POST /public/nango/webhook`.
 *
 * Mounted before Clerk auth: Nango's delivery is server-to-server and carries
 * no session. Authenticity comes from the `X-Nango-Signature` HMAC, verified
 * against `NANGO_WEBHOOK_SECRET` before anything else is read. Unsigned
 * requests are rejected — there is no development bypass, because this handler
 * writes tenant CRM data.
 *
 * Two payload types matter:
 *   - `auth`  → a tenant finished (or refreshed) an authorisation. Activates
 *               the local row and records the connection → workspace mapping
 *               that every later sync webhook depends on.
 *   - `sync`  → a sync finished. We pull the changed records for that model and
 *               ingest them, writing a `nango_sync_runs` row either way.
 *
 * Status codes are the retry contract. A recognised webhook answers 200 even
 * when ingest fails — the failure is recorded on the run row and surfaced in
 * the UI, and a retry would replay it. The one exception is a sync webhook
 * whose connection→workspace mapping has not propagated yet: that answers 503
 * so Nango redelivers rather than the sync being silently dropped. Signature
 * failures answer 401.
 */

import { Hono } from 'hono';
import {
  NANGO_SIGNATURE_HEADER,
  isAuthWebhook,
  isSyncWebhook,
  parseNangoWebhook,
  verifyNangoSignature,
  type NangoAuthWebhook,
  type NangoSyncWebhook,
} from '@weldsuite/nango';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { Env, Variables } from '../types';
import { getTenantDbForWorkspace, type Database } from '../db';
import { ingestRecords, resolveSync } from '../services/nango/ingest';
import {
  findConnectionByNangoId,
  findConnectionByProvider,
  finishSyncRun,
  getNangoClient,
  markConnectionActive,
  markConnectionError,
  rememberConnectionWorkspace,
  resolveConnectionWorkspace,
  startSyncRun,
} from '../services/nango/connections';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Records pulled per page. Nango's cap is 1000; stay well under the CPU budget. */
const RECORDS_PAGE_SIZE = 200;
/** Pages per webhook. Anything larger is left for the next incremental run. */
const MAX_PAGES_PER_WEBHOOK = 10;

app.post('/webhook', async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header(NANGO_SIGNATURE_HEADER) ?? null;

  const valid = await verifyNangoSignature(c.env.NANGO_WEBHOOK_SECRET, raw, signature);
  if (!valid) {
    return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } }, 401);
  }

  const payload = parseNangoWebhook(raw);
  // Ack unknown shapes so Nango stops retrying something we will never handle.
  if (!payload) return c.json({ ok: true, ignored: 'unrecognised_payload' });

  try {
    if (isAuthWebhook(payload)) {
      const outcome = await handleAuthWebhook(c.env, payload);
      return c.json(outcome.body, outcome.status ?? 200);
    }
    if (isSyncWebhook(payload)) {
      const outcome = await handleSyncWebhook(c.env, payload);
      return c.json(outcome.body, outcome.status ?? 200);
    }
    return c.json({ ok: true, ignored: payload.type });
  } catch (err) {
    console.error('[nango-webhook] handler failed:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to process webhook' } }, 500);
  }
});

/**
 * A handler's answer to Nango.
 *
 * 200 ends delivery — use it when the payload is genuinely nothing to us, or
 * when we processed it (including a recorded failure, which a retry would only
 * reproduce). 503 asks Nango to redeliver, and is reserved for state we expect
 * to exist shortly.
 */
interface WebhookOutcome {
  body: Record<string, unknown>;
  status?: 200 | 503;
}

/**
 * Publish a connector lifecycle event from the webhook path.
 *
 * `publishEntityEventRaw` rather than `publishEntityEvent`: there is no Hono
 * context carrying a tenant DB here. The actor is `system` — the webhook is
 * Nango calling us, not a user acting. Failures are logged, never fatal: the
 * connection state is already committed, and a thrown event would turn a
 * successful authorisation into a webhook Nango retries forever.
 */
async function publishConnectionEvent(
  env: Env,
  clerkOrgId: string,
  db: Database,
  connectionId: string,
  action: 'connected' | 'auth_error',
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await publishEntityEventRaw({
      env: env as never,
      db: db as never,
      workspaceId: clerkOrgId,
      userId: 'system',
      entityType: 'connector_connection',
      action,
      entityId: connectionId,
      data: { id: connectionId, ...data },
    });
  } catch (err) {
    console.error(`[nango-webhook] failed to publish ${action} for ${connectionId}:`, err);
  }
}

// ============================================================================
// auth
// ============================================================================

/**
 * A connection was created, overridden or refreshed.
 *
 * The tenant comes from `endUser.organizationId` — the Clerk org id stamped on
 * the Connect session. This is the only webhook that carries it, which is why
 * the mapping is persisted to KV here for the sync webhooks that follow.
 */
async function handleAuthWebhook(env: Env, payload: NangoAuthWebhook): Promise<WebhookOutcome> {
  const clerkOrgId =
    payload.endUser?.organizationId ??
    (await resolveConnectionWorkspace(env, payload.providerConfigKey, payload.connectionId));

  if (!clerkOrgId) {
    console.warn(
      `[nango-webhook] auth webhook without a resolvable workspace (${payload.providerConfigKey}/${payload.connectionId})`,
    );
    return { body: { ok: true, ignored: 'unknown_workspace' } };
  }

  const db = await getTenantDbForWorkspace(env, clerkOrgId);
  const connection =
    (await findConnectionByNangoId(db, payload.providerConfigKey, payload.connectionId)) ??
    (await findConnectionByProvider(db, payload.providerConfigKey));

  if (!connection) {
    // The connect flow always creates the pending row first, so this means the
    // authorisation was started outside WeldSuite. Nothing safe to attach it to.
    console.warn(`[nango-webhook] no local row for ${payload.providerConfigKey}/${payload.connectionId}`);
    return { body: { ok: true, ignored: 'unknown_connection' } };
  }

  if (!payload.success) {
    await markConnectionError({
      db,
      connectionId: connection.id,
      status: 'auth_error',
      message: payload.error?.description ?? 'Authorisation failed',
    });
    await publishConnectionEvent(env, clerkOrgId, db, connection.id, 'auth_error', {
      providerConfigKey: payload.providerConfigKey,
      error: payload.error?.description ?? 'Authorisation failed',
    });
    return { body: { ok: true, status: 'auth_error' } };
  }

  await markConnectionActive({
    db,
    connectionId: connection.id,
    nangoConnectionId: payload.connectionId,
  });
  await rememberConnectionWorkspace(env, payload.providerConfigKey, payload.connectionId, clerkOrgId);

  // Same event the finalize route emits — whichever path wins the race, the
  // lifecycle looks identical to workflows and the audit log.
  await publishConnectionEvent(env, clerkOrgId, db, connection.id, 'connected', {
    providerConfigKey: payload.providerConfigKey,
    provider: payload.provider,
    operation: payload.operation,
  });

  return { body: { ok: true, status: 'active', operation: payload.operation } };
}

// ============================================================================
// sync
// ============================================================================

async function handleSyncWebhook(env: Env, payload: NangoSyncWebhook): Promise<WebhookOutcome> {
  const clerkOrgId = await resolveConnectionWorkspace(env, payload.providerConfigKey, payload.connectionId);
  if (!clerkOrgId) {
    // Ask for redelivery rather than acking. The signature already proved this
    // webhook is for OUR Nango environment, so a miss here is almost always the
    // KV mapping (eventually consistent) not having propagated yet from a
    // connect that just completed. Acking would silently drop the tenant's
    // first sync — the one that matters most.
    console.warn(
      `[nango-webhook] sync webhook for unmapped connection ${payload.providerConfigKey}/${payload.connectionId} — asking Nango to retry`,
    );
    return {
      body: { ok: false, retry: true, reason: 'workspace_mapping_not_found' },
      status: 503,
    };
  }

  const resolved = resolveSync(payload.providerConfigKey, payload.model);
  if (!resolved) {
    // A sync we have no mapper for — acking keeps Nango from retrying forever.
    return { body: { ok: true, ignored: 'unmapped_model' } };
  }

  const db = await getTenantDbForWorkspace(env, clerkOrgId);
  const connection = await findConnectionByNangoId(db, payload.providerConfigKey, payload.connectionId);
  if (!connection) return { body: { ok: true, ignored: 'unknown_connection' } };

  const runId = await startSyncRun({
    db,
    connectionId: connection.id,
    syncName: payload.syncName,
    model: payload.model,
    trigger: 'webhook',
    syncType: payload.syncType,
  });

  if (!payload.success) {
    await finishSyncRun({
      db,
      runId,
      connectionId: connection.id,
      status: 'error',
      error: payload.error?.description ?? 'Sync failed at the provider',
    });
    return { body: { ok: true, status: 'error' } };
  }

  const client = getNangoClient(env);
  if (!client) {
    await finishSyncRun({
      db,
      runId,
      connectionId: connection.id,
      status: 'error',
      error: 'Connector framework is not configured for this environment',
    });
    return { body: { ok: true, ignored: 'nango_not_configured' } };
  }

  // Watermark: prefer the window Nango synced, falling back to our own record.
  // Reading records from before the watermark is wasteful but harmless — the
  // checksum comparison turns a re-read into a skip.
  const storedWatermark = connection.syncWatermarks?.[payload.model];
  const modifiedAfter = payload.modifiedAfter ?? storedWatermark;
  const runStartedAt = new Date().toISOString();

  const totals = { created: 0, modified: 0, skipped: 0, deleted: 0, failed: 0 };
  const errorSamples: Array<{ externalId: string; message: string }> = [];
  let truncated = false;

  try {
    let pages = 0;
    for await (const page of client.iterateRecords({
      providerConfigKey: payload.providerConfigKey,
      connectionId: payload.connectionId,
      model: payload.model,
      modifiedAfter,
      limit: RECORDS_PAGE_SIZE,
      maxPages: MAX_PAGES_PER_WEBHOOK,
    })) {
      pages++;
      const result = await ingestRecords({
        db: db as unknown as Database,
        connectionId: connection.id,
        connector: resolved.connector,
        sync: resolved.sync,
        records: page.records as Array<Record<string, unknown>>,
        ownerId: connection.connectedBy ?? 'system',
        workspaceId: clerkOrgId,
        env: env as unknown as Record<string, unknown>,
      });

      totals.created += result.created;
      totals.modified += result.modified;
      totals.skipped += result.skipped;
      totals.deleted += result.deleted;
      totals.failed += result.failed;
      for (const sample of result.errorSamples) {
        if (errorSamples.length < 5) errorSamples.push(sample);
      }

      // Hit the page ceiling with a cursor still open — the remainder rides on
      // the next run rather than risking a mid-tenant CPU timeout.
      if (pages >= MAX_PAGES_PER_WEBHOOK && page.cursor) truncated = true;
    }

    const status = totals.failed > 0 ? 'partial' : 'success';
    await finishSyncRun({
      db,
      runId,
      connectionId: connection.id,
      status,
      reported: payload.responseResults,
      applied: totals,
      error: totals.failed > 0 ? `${totals.failed} record(s) failed to import` : null,
      errorSamples,
      // Only advance on a clean, complete pass. Truncated means pages we never
      // read; `partial` means records that failed to import. Advancing past
      // either is silent data loss — `finishSyncRun` enforces the status half
      // of this independently.
      watermark: truncated || status !== 'success' ? null : { model: payload.model, at: runStartedAt },
    });

    return { body: { ok: true, status, applied: totals, truncated } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[nango-webhook] ingest failed:', err);
    await finishSyncRun({
      db,
      runId,
      connectionId: connection.id,
      status: totals.created + totals.modified > 0 ? 'partial' : 'error',
      reported: payload.responseResults,
      applied: totals,
      error: message,
      errorSamples,
      watermark: null,
    });
    return { body: { ok: true, status: 'error', error: message } };
  }
}

export { app as nangoWebhookRoutes };
