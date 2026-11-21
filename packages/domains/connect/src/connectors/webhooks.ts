/**
 * Store-pushed connector webhooks.
 *
 * On connect we register per-object webhooks on the store. After that the
 * tenant database is opened only when the store reports a change — no cron.
 */

import {
  ConnectorApiError,
  allowsInboundSync,
  connectorWebhookDeliveryUrl,
  connectorWebhookKvKey,
  enabledConnectorSyncs,
  getConnector,
  isRoutedMoneybirdTopic,
  matchWebhookTopic,
  MoneybirdClient,
  readWebhookSignatureFromHeaders,
  readWebhookTopicFromHeaders,
  readWebhookTopicFromPayload,
  resolveConnectorObjectDirection,
  STRIPE_CONNECT_VERIFIED_HEADER,
  STRIPE_DEAUTHORIZED_EVENT,
  StripeClient,
  stripeAccountKvKey,
  unwrapWebhookPayload,
  verifyConnectorWebhook,
  webhookTopicsFor,
  type ConnectorWebhookKvEntry,
  type StripeAccountKvEntry,
} from '@weldsuite/connectors';
import type { ConnectorWebhookRegistration } from '@weldsuite/db/schema';
import type { Database } from '@weldsuite/worker-kit/db';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import {
  createConnectorClient,
  skippedFinancialAccountIds,
  withRuntimeCredentials,
  type ConnectorRuntimeEnv,
} from './clients';
import {
  decryptCredentials,
  encryptWebhookSecret,
  finishSyncRun,
  keyringFromEnv,
  markConnectionError,
  maybeDecryptWebhookSecret,
  startSyncRun,
  type ConnectorConnectionRow,
  updateConnectionSettings,
} from './connections';
import { ingestRecords } from './ingest';
import { modifiedAtOf } from './mappers';
import { touchConnectorIndexWebhook, type ConnectorSyncIndexEnv } from '../connector-sync-index';
import { MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET, type MoneybirdAttachmentSyncContext } from './moneybird-attachments';
import { moneybirdDeliveryTargets, type MoneybirdDeliveryTarget } from './moneybird-webhooks';
import { STRIPE_PDF_DOWNLOAD_BUDGET, type StripeInvoicePdfContext } from './stripe-invoice-pdf';
import { pushAfterStripeIngest } from './moneybird-push';

export { generateWebhookSecret } from '@weldsuite/connectors';

/**
 * What the webhook helpers read: the KV cache holding the connection mapping,
 * the credential keyring, the D1 sync index, ENVIRONMENT (default delivery
 * host), an optional CONNECTOR_WEBHOOK_BASE_URL override and the R2 bucket
 * for Moneybird attachments. The env is also handed on to entity-event
 * publishing during ingest.
 */
export type ConnectorWebhooksEnv = Pick<
  DbEnv,
  'WORKSPACE_CACHE' | 'DATABASE_ENCRYPTION_KEY' | 'DATABASE_ENCRYPTION_KEY_V2'
> &
  ConnectorSyncIndexEnv &
  ConnectorRuntimeEnv & {
    ENVIRONMENT: string;
    STORAGE?: R2Bucket;
    CONNECTOR_WEBHOOK_BASE_URL?: string;
  };

function stripeInvoicePdfContext(
  env: ConnectorWebhooksEnv,
  client: ReturnType<typeof createConnectorClient>,
  workspaceId: string,
): StripeInvoicePdfContext | null {
  if (!(client instanceof StripeClient) || !env.STORAGE) return null;
  return { client, storage: env.STORAGE, workspaceId, budget: { remaining: STRIPE_PDF_DOWNLOAD_BUDGET } };
}

/** OAuth Stripe connections report through the platform's Connect webhook, not one of their own. */
function usesStripeConnectWebhook(connection: Pick<ConnectorConnectionRow, 'provider'>, credentials: Record<string, string>): boolean {
  return connection.provider === 'stripe' && !credentials.apiKey;
}

function moneybirdAttachmentContext(
  env: ConnectorWebhooksEnv,
  client: ReturnType<typeof createConnectorClient>,
  workspaceId: string,
): MoneybirdAttachmentSyncContext | null {
  if (!(client instanceof MoneybirdClient) || !env.STORAGE) return null;
  return {
    client,
    storage: env.STORAGE,
    workspaceId,
    budget: { remaining: MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET },
  };
}

export function connectorWebhookBaseUrl(env: ConnectorWebhooksEnv): string {
  const explicit = (env as { CONNECTOR_WEBHOOK_BASE_URL?: string }).CONNECTOR_WEBHOOK_BASE_URL;
  if (explicit) return explicit.replace(/(?<!\/)\/+$/, '');
  if (env.ENVIRONMENT === 'production') return 'https://integration-webhooks.weldsuite.org';
  if (env.ENVIRONMENT === 'test') return 'https://integration-webhooks-test.weldsuite.org';
  return 'http://localhost:8787';
}

export async function registerConnectionWebhooks(args: {
  db: Database;
  env: ConnectorWebhooksEnv;
  connection: ConnectorConnectionRow;
  credentials: Record<string, string>;
  webhookSecret: string;
}): Promise<{ registrations: ConnectorWebhookRegistration[]; warning: string | null }> {
  if (usesStripeConnectWebhook(args.connection, args.credentials)) {
    return { registrations: [], warning: null };
  }
  const deliveryUrl = connectorWebhookDeliveryUrl(connectorWebhookBaseUrl(args.env), args.connection.id);
  if (deliveryUrl.startsWith('http://')) {
    return {
      registrations: [],
      warning: 'Webhooks need a public HTTPS URL. Use Sync now until this environment is reachable from the store.',
    };
  }

  const enabled = enabledConnectorSyncs(
    getConnector(args.connection.provider)!,
    args.connection.enabledSyncs,
  );
  const allowed = new Set(enabled.map((s) => s.settingKey));
  const topics = webhookTopicsFor(args.connection.provider).filter((topic) => allowed.has(topic.settingKey));
  if (topics.length === 0) {
    return { registrations: [], warning: null };
  }
  const client = createConnectorClient(
    args.connection.provider,
    args.credentials,
    args.connection.externalAccountId,
  );

  const registrations: ConnectorWebhookRegistration[] = [];
  const failures: string[] = [];
  let providerSecret: string | undefined;

  try {
    const created = await client.registerWebhooks({
      deliveryUrl,
      secret: args.webhookSecret,
      topics,
    });
    for (const row of created) {
      if (row.id) registrations.push({ id: row.id, topic: row.topic, deliveryUrl: row.deliveryUrl });
      if (row.secret) providerSecret = row.secret;
    }
  } catch (err) {
    failures.push(...topics.map((topic) => topic.topic));
    console.error('[connectors/webhooks] register failed', err);
  }

  const keyring = keyringFromEnv(args.env);
  await updateConnectionSettings({
    db: args.db,
    connectionId: args.connection.id,
    webhookRegistrations: registrations,
    webhookSecret: await encryptWebhookSecret(providerSecret ?? args.webhookSecret, keyring),
  });

  let warning: string | null = null;
  if (failures.length) {
    warning = `Connected, but ${failures.length} webhook(s) failed to register. Use Sync now until the store can reach WeldSuite.`;
  } else if (registrations.length === 0) {
    warning = 'Connected without webhooks. Use Sync now to import, then reconnect to enable push updates.';
  }
  return { registrations, warning };
}

export async function unregisterConnectionWebhooks(args: {
  connection: ConnectorConnectionRow;
  credentials: Record<string, string>;
}): Promise<void> {
  const registrations = args.connection.webhookRegistrations ?? [];
  if (registrations.length === 0) return;
  try {
    const client = createConnectorClient(
      args.connection.provider,
      args.credentials,
      args.connection.externalAccountId,
    );
    for (const registration of registrations) {
      try {
        await client.deleteWebhook(registration.id);
      } catch (err) {
        console.error('[connectors/webhooks] unregister failed', registration.id, err);
      }
    }
  } catch (err) {
    console.error('[connectors/webhooks] client for unregister failed', err);
  }
}

export async function putConnectorWebhookMapping(args: {
  env: ConnectorWebhooksEnv;
  connectionId: string;
  workspaceId: string;
  provider: string;
}): Promise<void> {
  const entry: ConnectorWebhookKvEntry = { workspaceId: args.workspaceId, provider: args.provider };
  await args.env.WORKSPACE_CACHE.put(connectorWebhookKvKey(args.connectionId), JSON.stringify(entry), {
    expirationTtl: 86400 * 365,
  });
}

export async function deleteConnectorWebhookMapping(env: ConnectorWebhooksEnv, connectionId: string): Promise<void> {
  await env.WORKSPACE_CACHE.delete(connectorWebhookKvKey(connectionId));
}

async function readStripeAccountEntry(env: ConnectorWebhooksEnv, accountId: string): Promise<StripeAccountKvEntry> {
  const raw = await env.WORKSPACE_CACHE.get(stripeAccountKvKey(accountId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StripeAccountKvEntry) : [];
  } catch {
    return [];
  }
}

/** Route the platform's Connect events for `accountId` to this connection (one account can be in several workspaces). */
export async function putStripeAccountMapping(args: {
  env: ConnectorWebhooksEnv;
  accountId: string;
  workspaceId: string;
  connectionId: string;
}): Promise<void> {
  const entries = (await readStripeAccountEntry(args.env, args.accountId)).filter(
    (entry) => entry.connectionId !== args.connectionId,
  );
  entries.push({ workspaceId: args.workspaceId, connectionId: args.connectionId });
  await args.env.WORKSPACE_CACHE.put(stripeAccountKvKey(args.accountId), JSON.stringify(entries), {
    expirationTtl: 86400 * 365,
  });
}

export async function deleteStripeAccountMapping(env: ConnectorWebhooksEnv, accountId: string, connectionId: string): Promise<void> {
  const entries = (await readStripeAccountEntry(env, accountId)).filter((entry) => entry.connectionId !== connectionId);
  if (entries.length === 0) {
    await env.WORKSPACE_CACHE.delete(stripeAccountKvKey(accountId));
    return;
  }
  await env.WORKSPACE_CACHE.put(stripeAccountKvKey(accountId), JSON.stringify(entries), { expirationTtl: 86400 * 365 });
}

export function resolveWebhookSecret(
  connection: ConnectorConnectionRow,
  credentials: Record<string, string>,
  decryptedWebhookSecret: string | null,
): string | null {
  if (connection.provider === 'shopify') return credentials.apiSecret || decryptedWebhookSecret;
  return decryptedWebhookSecret;
}

type WebhookResult = { ok: boolean; status: number; message: string };
type WebhookTopic = NonNullable<ReturnType<typeof matchWebhookTopic>>;
type WebhookSync = NonNullable<ReturnType<typeof getConnector>>['syncs'][number];

/** The topic of a delivery, or the response to answer with when it has none we handle. */
function resolveWebhookTopic(
  connection: ConnectorConnectionRow,
  headers: Headers,
  payload: Record<string, unknown>,
): { topic: WebhookTopic } | { result: WebhookResult } {
  const topicName =
    readWebhookTopicFromHeaders(connection.provider, headers)
    ?? readWebhookTopicFromPayload(connection.provider, payload);
  if (!topicName) {
    return { result: { ok: false, status: 400, message: 'missing webhook topic' } };
  }
  const topic = matchWebhookTopic(connection.provider, topicName);
  if (!topic) {
    return { result: { ok: true, status: 200, message: `ignored topic ${topicName}` } };
  }
  return { topic };
}

/**
 * The sync a delivery feeds (by name, else by setting key) when the
 * connection imports it, or the response that says why not.
 */
function inboundSync(
  connection: ConnectorConnectionRow,
  pick: { syncName?: string; settingKey?: string },
): { sync: WebhookSync } | { result: WebhookResult } {
  const connector = getConnector(connection.provider);
  const sync = connector?.syncs.find((s) =>
    pick.syncName ? s.syncName === pick.syncName : s.settingKey === pick.settingKey,
  );
  if (!connector || !sync) {
    return { result: { ok: true, status: 200, message: 'topic not enabled' } };
  }
  const enabled = enabledConnectorSyncs(connector, connection.enabledSyncs);
  if (!enabled.some((s) => s.syncName === sync.syncName)) {
    return { result: { ok: true, status: 200, message: 'sync disabled' } };
  }
  const direction = resolveConnectorObjectDirection({
    direction: connection.direction,
    objectSyncDirections: connection.objectSyncDirections,
    settingKey: sync.settingKey,
  });
  if (!allowsInboundSync(direction)) {
    return { result: { ok: true, status: 200, message: 'inbound sync disabled for object' } };
  }
  return { sync };
}

/**
 * Signature check. A Stripe Connect event was already verified by the ingress
 * worker with the platform secret and arrives marked; that header is trusted
 * only because this runs behind the internal-only `connector-event` route.
 */
async function deliveryVerified(args: {
  connection: ConnectorConnectionRow;
  credentials: Record<string, string>;
  keyring: ReturnType<typeof keyringFromEnv>;
  rawBody: string;
  headers: Headers;
}): Promise<WebhookResult | null> {
  if (
    usesStripeConnectWebhook(args.connection, args.credentials)
    && args.headers.get(STRIPE_CONNECT_VERIFIED_HEADER) === 'verified'
  ) {
    return null;
  }
  const webhookSecret = resolveWebhookSecret(
    args.connection,
    args.credentials,
    await maybeDecryptWebhookSecret(args.connection.webhookSecret, args.keyring),
  );
  if (!webhookSecret) {
    return { ok: false, status: 401, message: 'missing webhook secret' };
  }
  const verified = await verifyConnectorWebhook({
    provider: args.connection.provider,
    secret: webhookSecret,
    body: args.rawBody,
    signature: readWebhookSignatureFromHeaders(args.connection.provider, args.headers),
  });
  return verified ? null : { ok: false, status: 401, message: 'invalid webhook signature' };
}

/** Catch-up bookkeeping after a webhook import, and the Moneybird push when Stripe brought something new. */
async function afterWebhookIngest(args: {
  db: Database;
  env: ConnectorWebhooksEnv;
  connection: ConnectorConnectionRow;
  model: string;
  /** The delivered record, null when the records were read back (see below). */
  record: Record<string, unknown> | null;
  changed: boolean;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<void> {
  const stripe = args.connection.provider === 'stripe';
  // Records read back (Stripe's, Moneybird's routed ones) carry the re-read
  // time, not the event's: advancing the catch-up watermark with it could skip
  // a missed earlier event.
  const watermark = stripe || !args.record ? null : modifiedAtOf(args.record);
  await touchConnectorIndexWebhook(args.env, {
    connectionId: args.connection.id,
    watermarks: watermark
      ? { ...args.connection.syncWatermarks, [args.model]: watermark }
      : args.connection.syncWatermarks,
  });
  if (!stripe || !args.changed) return;
  const push = pushAfterStripeIngest({ db: args.db, env: args.env, stripeConnectionId: args.connection.id });
  if (args.waitUntil) args.waitUntil(push);
  else await push;
}

export interface ConnectorWebhookDelivery {
  db: Database;
  env: ConnectorWebhooksEnv;
  connection: ConnectorConnectionRow;
  ownerId: string;
  workspaceId: string;
  rawBody: string;
  headers: Headers;
  /** Runs follow-up work (the Moneybird push) after the response; awaited when absent. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof ConnectorApiError || err instanceof Error ? err.message : 'ingest failed';
}

/** One sync run: the delivery's records imported into `sync`. */
async function ingestDelivery(
  args: ConnectorWebhookDelivery,
  credentials: Record<string, string>,
  client: ReturnType<typeof createConnectorClient>,
  delivery: {
    sync: WebhookSync;
    loadRecords: () => Promise<Array<Record<string, unknown>>>;
    forceDeleted: boolean;
    /** The delivered record, for the catch-up watermark; null when the records were read back. */
    watermarkRecord: Record<string, unknown> | null;
  },
): Promise<WebhookResult> {
  const { sync } = delivery;
  const runId = await startSyncRun({
    db: args.db,
    connectionId: args.connection.id,
    syncName: sync.syncName,
    model: sync.model,
    trigger: 'webhook',
    syncType: 'WEBHOOK',
  });

  try {
    const records = await delivery.loadRecords();
    const ingested = await ingestRecords({
      db: args.db,
      connectionId: args.connection.id,
      provider: args.connection.provider,
      displayName: args.connection.displayName,
      storeUrl: client.storeUrl,
      sync,
      records,
      ownerId: args.ownerId,
      workspaceId: args.workspaceId,
      entityId: credentials.entityId?.trim() || null,
      env: args.env as unknown as Record<string, unknown>,
      forceDeleted: delivery.forceDeleted,
      moneybirdAttachments: moneybirdAttachmentContext(args.env, client, args.workspaceId),
      stripeInvoicePdfs: stripeInvoicePdfContext(args.env, client, args.workspaceId),
      skipFinancialAccountIds: skippedFinancialAccountIds(args.connection),
    });
    await finishSyncRun({
      db: args.db,
      runId,
      connectionId: args.connection.id,
      status: ingested.failed ? 'partial' : 'success',
      applied: ingested,
      error: ingested.failed ? ingested.errorSamples[0]?.message ?? 'ingest failed' : null,
      errorSamples: ingested.errorSamples,
    });
    await afterWebhookIngest({
      ...args,
      model: sync.model,
      record: delivery.watermarkRecord,
      changed: ingested.created + ingested.modified > 0,
    });
    return { ok: true, status: 200, message: 'ingested' };
  } catch (err) {
    const message = errorMessage(err);
    await finishSyncRun({
      db: args.db,
      runId,
      connectionId: args.connection.id,
      status: 'error',
      error: message,
    });
    return { ok: false, status: 500, message };
  }
}

/**
 * A Moneybird document, payment or statement event (`moneybird-webhooks.ts`):
 * one sync run per sync it feeds, reading back only what the connection imports.
 */
async function processRoutedMoneybirdDelivery(
  args: ConnectorWebhookDelivery,
  credentials: Record<string, string>,
  topic: WebhookTopic,
  payload: Record<string, unknown>,
): Promise<WebhookResult> {
  const client = createConnectorClient(args.connection.provider, credentials, args.connection.externalAccountId);
  if (!(client instanceof MoneybirdClient)) return { ok: true, status: 200, message: 'topic not enabled' };
  let targets: MoneybirdDeliveryTarget[];
  try {
    targets = await moneybirdDeliveryTargets({
      client,
      topic: topic.topic,
      kind: topic.kind,
      payload,
      entity: unwrapWebhookPayload(args.connection.provider, payload),
      wants: (syncName) => 'sync' in inboundSync(args.connection, { syncName }),
    });
  } catch (err) {
    return { ok: false, status: 500, message: errorMessage(err) };
  }
  if (targets.length === 0) {
    return { ok: true, status: 200, message: `nothing to import for ${topic.topic}` };
  }
  for (const target of targets) {
    const picked = inboundSync(args.connection, { syncName: target.syncName });
    if ('result' in picked) continue;
    const result = await ingestDelivery(args, credentials, client, {
      sync: picked.sync,
      loadRecords: () => Promise.resolve(target.records),
      forceDeleted: target.forceDeleted,
      watermarkRecord: null,
    });
    if (!result.ok) return result;
  }
  return { ok: true, status: 200, message: 'ingested' };
}

export async function processConnectorWebhook(args: ConnectorWebhookDelivery): Promise<WebhookResult> {
  if (args.connection.status === 'paused' || args.connection.deletedAt) {
    return { ok: true, status: 200, message: 'ignored paused connection' };
  }

  const keyring = keyringFromEnv(args.env);
  const stored = await decryptCredentials(args.connection.credentials ?? undefined, keyring);
  const rejected = await deliveryVerified({
    connection: args.connection,
    credentials: stored,
    keyring,
    rawBody: args.rawBody,
    headers: args.headers,
  });
  if (rejected) return rejected;
  const credentials = withRuntimeCredentials(args.connection, stored, args.env);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(args.rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, message: 'invalid JSON body' };
  }

  if (args.connection.provider === 'stripe' && payload.type === STRIPE_DEAUTHORIZED_EVENT) {
    await markConnectionError({
      db: args.db,
      connectionId: args.connection.id,
      status: 'auth_error',
      message: 'The Stripe account disconnected WeldSuite. Connect it again to resume the import.',
    });
    return { ok: true, status: 200, message: 'deauthorized' };
  }

  const resolved = resolveWebhookTopic(args.connection, args.headers, payload);
  if ('result' in resolved) return resolved.result;
  const { topic } = resolved;
  if (args.connection.provider === 'moneybird' && isRoutedMoneybirdTopic(topic.topic)) {
    return processRoutedMoneybirdDelivery(args, credentials, topic, payload);
  }

  const picked = inboundSync(args.connection, topic);
  if ('result' in picked) return picked.result;
  const { sync } = picked;
  const client = createConnectorClient(
    args.connection.provider,
    credentials,
    args.connection.externalAccountId,
  );
  const record = unwrapWebhookPayload(args.connection.provider, payload);
  return ingestDelivery(args, credentials, client, {
    sync,
    loadRecords: () => (client.hydrateWebhookRecords ? client.hydrateWebhookRecords(sync, record) : Promise.resolve([record])),
    forceDeleted: topic.kind === 'delete',
    watermarkRecord: record,
  });
}

