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
  readWebhookTopicFromPayload,
  unwrapWebhookPayload,
  verifyConnectorWebhook,
  webhookTopicsFor,
  type ConnectorWebhookKvEntry,
} from '@weldsuite/connectors';
import type { ConnectorWebhookRegistration } from '@weldsuite/db/schema';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { createConnectorClient } from './clients';
import {
  decryptCredentials,
  encryptWebhookSecret,
  finishSyncRun,
  keyringFromEnv,
  maybeDecryptWebhookSecret,
  startSyncRun,
  type ConnectorConnectionRow,
  updateConnectionSettings,
} from './connections';
import { ingestRecords } from './ingest';
import { modifiedAtOf } from './mappers';
import { touchConnectorIndexWebhook } from '../../lib/connector-sync-index';

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

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(args.rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, message: 'invalid JSON body' };
  }

  const topicName =
    readWebhookTopicFromHeaders(args.connection.provider, args.headers)
    ?? readWebhookTopicFromPayload(args.connection.provider, payload);
  if (!topicName) {
    return { ok: false, status: 400, message: 'missing webhook topic' };
  }
  const topic = matchWebhookTopic(args.connection.provider, topicName);
  if (!topic) {
    return { ok: true, status: 200, message: `ignored topic ${topicName}` };
  }

  const connector = getConnector(args.connection.provider);
  const sync = connector?.syncs.find((s) =>
    topic.syncName ? s.syncName === topic.syncName : s.settingKey === topic.settingKey,
  );
  if (!sync) {
    return { ok: true, status: 200, message: 'topic not enabled' };
  }
  const enabled = enabledConnectorSyncs(connector!, args.connection.enabledSyncs);
  if (!enabled.some((s) => s.syncName === sync.syncName)) {
    return { ok: true, status: 200, message: 'sync disabled' };
  }

  const record = unwrapWebhookPayload(args.connection.provider, payload);

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
      records: [record],
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
    const watermark = modifiedAtOf(record);
    await touchConnectorIndexWebhook(args.env, {
      connectionId: args.connection.id,
      watermarks: watermark
        ? { ...(args.connection.syncWatermarks ?? {}), [sync.model]: watermark }
        : args.connection.syncWatermarks,
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
