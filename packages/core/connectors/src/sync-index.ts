/**
 * D1 connector_sync_index — always-on schedule + probe copy of a connection.
 *
 * Tenant Neon stays asleep until a probe (or reconcile fingerprint) says the
 * store actually has new data. SQL is shared by app-api (lifecycle writes)
 * and integration-sync-worker (due sweep).
 */

import {
  RECONCILE_INTERVAL_MINUTES,
  WEBHOOK_HEALTHY_SKIP_MINUTES,
  connectorIntervalMinutes,
  connectorSyncMode,
  type ConnectorSyncMode,
} from './catalog';

export type ConnectorSyncIndexMode = ConnectorSyncMode;

export interface ConnectorSyncIndexRow {
  connection_id: string;
  workspace_id: string;
  clerk_org_id: string;
  provider: string;
  source_kind: string;
  mode: ConnectorSyncIndexMode;
  enabled: number;
  next_due_at: number;
  interval_minutes: number;
  encrypted_credentials: string | null;
  watermarks: string;
  enabled_syncs: string | null;
  last_webhook_at: number | null;
  last_probe_at: number | null;
  last_ingest_at: number | null;
  last_error: string | null;
  backoff_until: number | null;
  reconcile_fingerprint: string | null;
  next_reconcile_at: number | null;
  updated_at: number;
}

/** Minimal D1 surface used by the index helpers. */
export interface ConnectorSyncIndexDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = ConnectorSyncIndexRow>(): Promise<{ results: T[] }>;
    };
  };
}

export interface UpsertConnectorSyncIndexInput {
  connectionId: string;
  workspaceId: string;
  clerkOrgId: string;
  provider: string;
  enabled: boolean;
  encryptedCredentialsJson: string | null;
  watermarks: Record<string, string> | null;
  enabledSyncs: string[] | null;
  now?: number;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseWatermarks(raw: string | null | undefined): Record<string, string> {
  return parseJson<Record<string, string>>(raw, {});
}

export function parseEnabledSyncs(raw: string | null | undefined): string[] | null {
  const value = parseJson<string[] | null>(raw, null);
  return Array.isArray(value) ? value : null;
}

export function parseFingerprint(raw: string | null | undefined): Record<string, number> | null {
  const value = parseJson<Record<string, number> | null>(raw, null);
  return value && typeof value === 'object' ? value : null;
}

export function shouldSkipHealthyWebhook(row: ConnectorSyncIndexRow, now: number): boolean {
  if (row.mode !== 'webhook_catchup' || row.last_webhook_at == null) return false;
  return now - row.last_webhook_at < WEBHOOK_HEALTHY_SKIP_MINUTES * 60_000;
}

export function nextDueAt(intervalMinutes: number, now: number): number {
  return now + intervalMinutes * 60_000;
}

export function backoffUntil(
  kind: 'auth' | 'rate_limit' | 'transient',
  now: number,
  retryAfterSeconds?: number,
): number {
  if (kind === 'auth') return now + 6 * 60 * 60_000;
  if (kind === 'rate_limit') {
    const waitMs = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 15 * 60_000;
    return now + waitMs;
  }
  return now + 30 * 60_000;
}

export async function upsertConnectorSyncIndex(
  d1: ConnectorSyncIndexDb,
  input: UpsertConnectorSyncIndexInput,
): Promise<void> {
  const now = input.now ?? Date.now();
  const intervalMinutes = connectorIntervalMinutes(input.provider);
  const mode = connectorSyncMode(input.provider);
  await d1
    .prepare(
      `INSERT INTO connector_sync_index (
         connection_id, workspace_id, clerk_org_id, provider, source_kind, mode,
         enabled, next_due_at, interval_minutes, encrypted_credentials, watermarks,
         enabled_syncs, last_webhook_at, last_probe_at, last_ingest_at, last_error,
         backoff_until, reconcile_fingerprint, next_reconcile_at, updated_at
       ) VALUES (?, ?, ?, ?, 'connector', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         clerk_org_id = excluded.clerk_org_id,
         provider = excluded.provider,
         mode = excluded.mode,
         enabled = excluded.enabled,
         interval_minutes = excluded.interval_minutes,
         encrypted_credentials = excluded.encrypted_credentials,
         watermarks = excluded.watermarks,
         enabled_syncs = excluded.enabled_syncs,
         next_due_at = CASE
           WHEN connector_sync_index.next_due_at > excluded.next_due_at THEN connector_sync_index.next_due_at
           ELSE excluded.next_due_at
         END,
         last_error = CASE WHEN excluded.enabled = 1 THEN NULL ELSE connector_sync_index.last_error END,
         backoff_until = CASE WHEN excluded.enabled = 1 THEN NULL ELSE connector_sync_index.backoff_until END,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.connectionId,
      input.workspaceId,
      input.clerkOrgId,
      input.provider,
      mode,
      input.enabled ? 1 : 0,
      nextDueAt(intervalMinutes, now),
      intervalMinutes,
      input.encryptedCredentialsJson,
      JSON.stringify(input.watermarks ?? {}),
      input.enabledSyncs ? JSON.stringify(input.enabledSyncs) : null,
      nextDueAt(RECONCILE_INTERVAL_MINUTES, now),
      now,
    )
    .run();
}

export async function setConnectorSyncIndexEnabled(
  d1: ConnectorSyncIndexDb,
  connectionId: string,
  enabled: boolean,
  now: number = Date.now(),
): Promise<void> {
  await d1
    .prepare(
      `UPDATE connector_sync_index
          SET enabled = ?, backoff_until = NULL, last_error = NULL, updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(enabled ? 1 : 0, now, connectionId)
    .run();
}

export async function deleteConnectorSyncIndex(
  d1: ConnectorSyncIndexDb,
  connectionId: string,
): Promise<void> {
  await d1.prepare(`DELETE FROM connector_sync_index WHERE connection_id = ?`).bind(connectionId).run();
}

export async function touchConnectorSyncIndexWebhook(
  d1: ConnectorSyncIndexDb,
  args: {
    connectionId: string;
    watermarks?: Record<string, string> | null;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  if (args.watermarks) {
    await d1
      .prepare(
        `UPDATE connector_sync_index
            SET last_webhook_at = ?, watermarks = ?, last_ingest_at = ?, last_error = NULL, updated_at = ?
          WHERE connection_id = ?`,
      )
      .bind(now, JSON.stringify(args.watermarks), now, now, args.connectionId)
      .run();
    return;
  }
  await d1
    .prepare(
      `UPDATE connector_sync_index
          SET last_webhook_at = ?, last_ingest_at = ?, last_error = NULL, updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(now, now, now, args.connectionId)
    .run();
}

export async function listDueConnectorSyncIndex(
  d1: ConnectorSyncIndexDb,
  now: number = Date.now(),
  limit = 50,
): Promise<ConnectorSyncIndexRow[]> {
  const { results } = await d1
    .prepare(
      `SELECT * FROM connector_sync_index
        WHERE enabled = 1
          AND (backoff_until IS NULL OR backoff_until <= ?)
          AND (next_due_at <= ? OR (next_reconcile_at IS NOT NULL AND next_reconcile_at <= ?))
        ORDER BY next_due_at ASC
        LIMIT ?`,
    )
    .bind(now, now, now, limit)
    .all<ConnectorSyncIndexRow>();
  return results ?? [];
}

export async function markConnectorSyncIndexProbed(
  d1: ConnectorSyncIndexDb,
  connectionId: string,
  intervalMinutes: number,
  now: number = Date.now(),
): Promise<void> {
  await d1
    .prepare(
      `UPDATE connector_sync_index
          SET last_probe_at = ?, next_due_at = ?, last_error = NULL, backoff_until = NULL, updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(now, nextDueAt(intervalMinutes, now), now, connectionId)
    .run();
}

export async function markConnectorSyncIndexIngested(
  d1: ConnectorSyncIndexDb,
  args: {
    connectionId: string;
    intervalMinutes: number;
    watermarks?: Record<string, string> | null;
    fingerprint?: Record<string, number> | null;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  await d1
    .prepare(
      `UPDATE connector_sync_index
          SET last_probe_at = ?, last_ingest_at = ?, next_due_at = ?,
              watermarks = COALESCE(?, watermarks),
              reconcile_fingerprint = COALESCE(?, reconcile_fingerprint),
              next_reconcile_at = ?, last_error = NULL, backoff_until = NULL, updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(
      now,
      now,
      nextDueAt(args.intervalMinutes, now),
      args.watermarks ? JSON.stringify(args.watermarks) : null,
      args.fingerprint ? JSON.stringify(args.fingerprint) : null,
      nextDueAt(RECONCILE_INTERVAL_MINUTES, now),
      now,
      args.connectionId,
    )
    .run();
}

export async function markConnectorSyncIndexReconciled(
  d1: ConnectorSyncIndexDb,
  connectionId: string,
  fingerprint: Record<string, number>,
  now: number = Date.now(),
): Promise<void> {
  await d1
    .prepare(
      `UPDATE connector_sync_index
          SET reconcile_fingerprint = ?, next_reconcile_at = ?, last_probe_at = ?, last_error = NULL, updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(JSON.stringify(fingerprint), nextDueAt(RECONCILE_INTERVAL_MINUTES, now), now, now, connectionId)
    .run();
}

export async function markConnectorSyncIndexBackoff(
  d1: ConnectorSyncIndexDb,
  args: {
    connectionId: string;
    error: string;
    until: number;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  await d1
    .prepare(
      `UPDATE connector_sync_index
          SET last_error = ?, backoff_until = ?, last_probe_at = ?, next_due_at = ?, updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(args.error.slice(0, 2000), args.until, now, args.until, now, args.connectionId)
    .run();
}
