/**
 * Store-pushed connector webhooks.
 *
 * On connect we register per-object webhooks on the store. After that the
 * tenant database is opened only when the store reports a change — no cron.
 */

import {
  ConnectorApiError,
  connectorWebhookDeliveryUrl,
  connectorWebhookKvKey,
  enabledConnectorSyncs,
  generateWebhookSecret,
  getConnector,
  matchWebhookTopic,
  readWebhookSignatureFromHeaders,
  readWebhookTopicFromHeaders,
  ShopifyClient,
  verifyConnectorWebhook,
  webhookTopicsFor,
  WooCommerceClient,
  type ConnectorWebhookKvEntry,
} from '@weldsuite/connectors';
import type { ConnectorWebhookRegistration } from '@weldsuite/db/schema';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { createConnectorClient } from './clients';
import {
  decryptCredentials,
  finishSyncRun,
  keyringFromEnv,
  maybeDecryptWebhookSecret,
  startSyncRun,
  type ConnectorConnectionRow,
  updateConnectionSettings,
} from './connections';
import { ingestRecords } from './ingest';

export function connectorWebhookBaseUrl(env: Env): string {
  const explicit = (env as { CONNECTOR_WEBHOOK_BASE_URL?: string }).CONNECTOR_WEBHOOK_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  if (env.ENVIRONMENT === 'production') return 'https://integration-webhooks.weldsuite.org';
  if (env.ENVIRONMENT === 'test') return 'https://integration-webhooks-test.weldsuite.org';
  return 'http://localhost:8787';
}

export async function registerConnectionWebhooks(args: {
  db: Database;
  env: Env;
  connection: ConnectorConnectionRow;
  credentials: Record<string, string>;
  webhookSecret: string;
}): Promise<{ registrations: ConnectorWebhookRegistration[]; warning: string | null }> {
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
  const client = createConnectorClient(
    args.connection.provider,
    args.credentials,
    args.connection.externalAccountId,
  );

  const registrations: ConnectorWebhookRegistration[] = [];
  const failures: string[] = [];

  for (const topic of topics) {
    try {
      if (client instanceof WooCommerceClient) {
        const created = await client.createWebhook({
          name: `WeldSuite ${topic.topic}`,
          topic: topic.topic,
          deliveryUrl,
          secret: args.webhookSecret,
        });
        registrations.push({ id: created.id, topic: created.topic, deliveryUrl: created.deliveryUrl });
      } else if (client instanceof ShopifyClient) {
        const created = await client.createWebhook(topic.topic, deliveryUrl);
        registrations.push({ id: created.id, topic: created.topic, deliveryUrl: created.address });
      }
    } catch (err) {
      failures.push(topic.topic);
      console.error('[connectors/webhooks] register failed', topic.topic, err);
    }
  }

  await updateConnectionSettings({
    db: args.db,
    connectionId: args.connection.id,
    webhookRegistrations: registrations,
  });

  return {
    registrations,
    warning: failures.length
      ? `Connected, but ${failures.length} webhook(s) failed to register. Use Sync now until the store can reach WeldSuite.`
      : registrations.length === 0
        ? 'Connected without webhooks. Use Sync now to import, then reconnect to enable push updates.'
        : null,
  };
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
        if (client instanceof WooCommerceClient) await client.deleteWebhook(registration.id);
        else if (client instanceof ShopifyClient) await client.deleteWebhook(registration.id);
      } catch (err) {
        console.error('[connectors/webhooks] unregister failed', registration.id, err);
      }
    }
  } catch (err) {
    console.error('[connectors/webhooks] client for unregister failed', err);
  }
}

export async function putConnectorWebhookMapping(args: {
  env: Env;
  connectionId: string;
  workspaceId: string;
  provider: string;
}): Promise<void> {
  const entry: ConnectorWebhookKvEntry = { workspaceId: args.workspaceId, provider: args.provider };
  await args.env.WORKSPACE_CACHE.put(connectorWebhookKvKey(args.connectionId), JSON.stringify(entry), {
    expirationTtl: 86400 * 365,
  });
}

export async function deleteConnectorWebhookMapping(env: Env, connectionId: string): Promise<void> {
  await env.WORKSPACE_CACHE.delete(connectorWebhookKvKey(connectionId));
}

export function resolveWebhookSecret(
  connection: ConnectorConnectionRow,
  credentials: Record<string, string>,
  decryptedWebhookSecret: string | null,
): string | null {
  if (connection.provider === 'shopify') return credentials.apiSecret || decryptedWebhookSecret;
  return decryptedWebhookSecret;
}

export async function processConnectorWebhook(args: {
  db: Database;
  env: Env;
  connection: ConnectorConnectionRow;
  ownerId: string;
  workspaceId: string;
  rawBody: string;
  headers: Headers;
}): Promise<{ ok: boolean; status: number; message: string }> {
  if (args.connection.status === 'paused' || args.connection.deletedAt) {
    return { ok: true, status: 200, message: 'ignored paused connection' };
  }

  const keyring = keyringFromEnv(args.env);
  const credentials = await decryptCredentials(args.connection.credentials ?? undefined, keyring);
  const webhookSecret = resolveWebhookSecret(
    args.connection,
    credentials,
    await maybeDecryptWebhookSecret(args.connection.webhookSecret, keyring),
  );
  if (!webhookSecret) {
    return { ok: false, status: 401, message: 'missing webhook secret' };
  }

  const signature = readWebhookSignatureFromHeaders(args.connection.provider, args.headers);
  const verified = await verifyConnectorWebhook({
    provider: args.connection.provider,
    secret: webhookSecret,
    body: args.rawBody,
    signature,
  });
  if (!verified) {
    return { ok: false, status: 401, message: 'invalid webhook signature' };
  }

  const topicName = readWebhookTopicFromHeaders(args.connection.provider, args.headers);
  if (!topicName) {
    return { ok: false, status: 400, message: 'missing webhook topic' };
  }
  const topic = matchWebhookTopic(args.connection.provider, topicName);
  if (!topic) {
    return { ok: true, status: 200, message: `ignored topic ${topicName}` };
  }

  const connector = getConnector(args.connection.provider);
  const sync = connector?.syncs.find((s) => s.settingKey === topic.settingKey);
  if (!sync) {
    return { ok: true, status: 200, message: 'topic not enabled' };
  }
  const enabled = enabledConnectorSyncs(connector!, args.connection.enabledSyncs);
  if (!enabled.some((s) => s.settingKey === topic.settingKey)) {
    return { ok: true, status: 200, message: 'sync disabled' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(args.rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, message: 'invalid JSON body' };
  }

  const runId = await startSyncRun({
    db: args.db,
    connectionId: args.connection.id,
    syncName: sync.syncName,
    model: sync.model,
    trigger: 'webhook',
    syncType: 'WEBHOOK',
  });

  const client = createConnectorClient(
    args.connection.provider,
    credentials,
    args.connection.externalAccountId,
  );

  try {
    const ingested = await ingestRecords({
      db: args.db,
      connectionId: args.connection.id,
      provider: args.connection.provider,
      displayName: args.connection.displayName,
      storeUrl: client.storeUrl,
      sync,
      records: [payload],
      ownerId: args.ownerId,
      workspaceId: args.workspaceId,
      env: args.env as unknown as Record<string, unknown>,
      forceDeleted: topic.kind === 'delete',
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
    return { ok: true, status: 200, message: 'ingested' };
  } catch (err) {
    const message = err instanceof ConnectorApiError ? err.message : err instanceof Error ? err.message : 'ingest failed';
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

export { generateWebhookSecret };
