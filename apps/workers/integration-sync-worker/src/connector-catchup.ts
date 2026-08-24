/**
 * Connector catch-up sweep — D1 due rows, remote probe, tenant ingest only on hits.
 *
 * A no-op tick never opens master or tenant Neon. Credentials are decrypted
 * from the D1 copy. Hybrid connectors skip the probe when a webhook landed
 * recently. Daily reconcile compares remote counts and only ingests on drift.
 */

import {
  ConnectorApiError,
  backoffUntil,
  connectorIntervalMinutes,
  connectorRemoteFingerprint,
  fingerprintsEqual,
  listDueConnectorSyncIndex,
  markConnectorSyncIndexBackoff,
  markConnectorSyncIndexIngested,
  markConnectorSyncIndexProbed,
  markConnectorSyncIndexReconciled,
  parseEnabledSyncs,
  parseFingerprint,
  parseWatermarks,
  probeConnectorUpdates,
  shouldSkipHealthyWebhook,
  type ConnectorSyncIndexDb,
  type ConnectorSyncIndexRow,
} from '@weldsuite/connectors';
import { maybeDecryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';

export interface ConnectorCatchupEnv {
  APP_API: Fetcher;
  INTERNAL_API_SECRET?: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}

export interface ConnectorCatchupStore {
  markProbed(connectionId: string, intervalMinutes: number, now: number): Promise<void>;
  markIngested(args: {
    connectionId: string;
    intervalMinutes: number;
    watermarks?: Record<string, string> | null;
    fingerprint?: Record<string, number> | null;
    now: number;
  }): Promise<void>;
  markReconciled(connectionId: string, fingerprint: Record<string, number>, now: number): Promise<void>;
  markBackoff(connectionId: string, error: string, until: number, now: number): Promise<void>;
}

export type ConnectorCatchupOutcome = 'skipped' | 'probed' | 'ingested' | 'backed_off';

export async function decryptIndexedCredentials(
  encryptedJson: string,
  keyring: EncryptionKeyring,
): Promise<Record<string, string>> {
  const parsed = JSON.parse(encryptedJson) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value) continue;
    out[key] = await maybeDecryptField(value, keyring);
  }
  return out;
}

export function d1ConnectorCatchupStore(d1: ConnectorSyncIndexDb): ConnectorCatchupStore {
  return {
    markProbed: (connectionId, intervalMinutes, now) =>
      markConnectorSyncIndexProbed(d1, connectionId, intervalMinutes, now),
    markIngested: (args) => markConnectorSyncIndexIngested(d1, args),
    markReconciled: (connectionId, fingerprint, now) =>
      markConnectorSyncIndexReconciled(d1, connectionId, fingerprint, now),
    markBackoff: (connectionId, error, until, now) =>
      markConnectorSyncIndexBackoff(d1, { connectionId, error, until, now }),
  };
}

function keyringFromCatchupEnv(env: ConnectorCatchupEnv): EncryptionKeyring {
  return { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
}

function classifyCatchupError(err: unknown): {
  kind: 'auth' | 'rate_limit' | 'transient';
  message: string;
  retryAfterSeconds?: number;
} {
  if (err instanceof ConnectorApiError) {
    const kind =
      err.kind === 'auth' ? 'auth' : err.kind === 'rate_limit' ? 'rate_limit' : 'transient';
    return { kind, message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  return { kind: 'transient', message: err instanceof Error ? err.message : 'catch-up failed' };
}

export async function requestConnectorCatchup(
  env: ConnectorCatchupEnv,
  row: ConnectorSyncIndexRow,
): Promise<{ ok: boolean; status: number; watermarks?: Record<string, string> | null; error?: string }> {
  const response = await env.APP_API.fetch(
    `https://internal/api/integrations/connections/${row.connection_id}/catch-up`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workspace-Id': row.clerk_org_id,
        'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
      },
    },
  );
  if (!response.ok) {
    return { ok: false, status: response.status, error: `catch-up HTTP ${response.status}` };
  }
  const body = (await response.json().catch(() => null)) as {
    data?: { watermarks?: Record<string, string> | null };
  } | null;
  return { ok: true, status: response.status, watermarks: body?.data?.watermarks ?? null };
}

export async function processConnectorCatchupRow(
  row: ConnectorSyncIndexRow,
  args: {
    now: number;
    store: ConnectorCatchupStore;
    decryptCredentials: (json: string) => Promise<Record<string, string>>;
    probe: typeof probeConnectorUpdates;
    fingerprint: typeof connectorRemoteFingerprint;
    catchUp: (row: ConnectorSyncIndexRow) => Promise<{
      ok: boolean;
      status: number;
      watermarks?: Record<string, string> | null;
      error?: string;
    }>;
  },
): Promise<ConnectorCatchupOutcome> {
  const intervalMinutes = row.interval_minutes || connectorIntervalMinutes(row.provider);
  const catchupDue = row.next_due_at <= args.now;
  const reconcileDue = row.next_reconcile_at != null && row.next_reconcile_at <= args.now;
  const skipProbe = catchupDue && shouldSkipHealthyWebhook(row, args.now) && !reconcileDue;

  if (skipProbe) {
    await args.store.markProbed(row.connection_id, intervalMinutes, args.now);
    return 'skipped';
  }

  if (!row.encrypted_credentials) {
    await args.store.markBackoff(
      row.connection_id,
      'missing encrypted credentials',
      backoffUntil('auth', args.now),
      args.now,
    );
    return 'backed_off';
  }

  try {
    const credentials = await args.decryptCredentials(row.encrypted_credentials);
    const enabledSyncs = parseEnabledSyncs(row.enabled_syncs);
    const watermarks = parseWatermarks(row.watermarks);

    let hasUpdates = false;
    if (catchupDue && !(shouldSkipHealthyWebhook(row, args.now) && reconcileDue)) {
      const probed = await args.probe({
        provider: row.provider,
        credentials,
        enabledSyncs,
        watermarks,
      });
      hasUpdates = probed.hasUpdates;
    }

    let remoteFingerprint: Record<string, number> | null = null;
    let fingerprintDrift = false;
    if (reconcileDue) {
      remoteFingerprint = await args.fingerprint({
        provider: row.provider,
        credentials,
        enabledSyncs,
      });
      fingerprintDrift = !fingerprintsEqual(remoteFingerprint, parseFingerprint(row.reconcile_fingerprint));
    }

    if (hasUpdates || fingerprintDrift) {
      const result = await args.catchUp(row);
      if (!result.ok) {
        const kind = result.status === 401 || result.status === 403 ? 'auth' : result.status === 429 ? 'rate_limit' : 'transient';
        await args.store.markBackoff(
          row.connection_id,
          result.error ?? `catch-up HTTP ${result.status}`,
          backoffUntil(kind, args.now),
          args.now,
        );
        return 'backed_off';
      }
      await args.store.markIngested({
        connectionId: row.connection_id,
        intervalMinutes,
        watermarks: result.watermarks ?? watermarks,
        fingerprint: remoteFingerprint,
        now: args.now,
      });
      return 'ingested';
    }

    if (reconcileDue && remoteFingerprint) {
      await args.store.markReconciled(row.connection_id, remoteFingerprint, args.now);
    }
    if (catchupDue) {
      await args.store.markProbed(row.connection_id, intervalMinutes, args.now);
    }
    return 'probed';
  } catch (err) {
    const classified = classifyCatchupError(err);
    await args.store.markBackoff(
      row.connection_id,
      classified.message,
      backoffUntil(classified.kind, args.now, classified.retryAfterSeconds),
      args.now,
    );
    return 'backed_off';
  }
}

export async function runConnectorCatchupSweep(
  d1: ConnectorSyncIndexDb,
  env: ConnectorCatchupEnv,
  now: number = Date.now(),
): Promise<{ skipped: number; probed: number; ingested: number; backedOff: number }> {
  const rows = await listDueConnectorSyncIndex(d1, now);
  const store = d1ConnectorCatchupStore(d1);
  const keyring = keyringFromCatchupEnv(env);
  const counts = { skipped: 0, probed: 0, ingested: 0, backedOff: 0 };

  for (const row of rows) {
    const outcome = await processConnectorCatchupRow(row, {
      now,
      store,
      decryptCredentials: (json) => decryptIndexedCredentials(json, keyring),
      probe: probeConnectorUpdates,
      fingerprint: connectorRemoteFingerprint,
      catchUp: (due) => requestConnectorCatchup(env, due),
    });
    if (outcome === 'skipped') counts.skipped += 1;
    else if (outcome === 'probed') counts.probed += 1;
    else if (outcome === 'ingested') counts.ingested += 1;
    else counts.backedOff += 1;
  }

  return counts;
}
