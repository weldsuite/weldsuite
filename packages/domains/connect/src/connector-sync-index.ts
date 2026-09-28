/**
 * D1 connector-sync-index (app-api side).
 *
 * integration-sync-worker polls `connector_sync_index` instead of opening every
 * tenant Neon. We own the write side: connect / credential update / pause /
 * resume / disconnect / successful ingest upsert or remove the matching row.
 *
 * All calls are best-effort — a D1 hiccup logs and returns rather than failing
 * the user's save. A stale row self-heals on the next connect or Sync now.
 */

import {
  connectorIntervalMinutes,
  deleteConnectorSyncIndex,
  markConnectorSyncIndexIngested,
  setConnectorSyncIndexEnabled,
  touchConnectorSyncIndexWebhook,
  upsertConnectorSyncIndex,
} from '@weldsuite/connectors';
import type { ConnectorConnectionRow } from './connectors/connections';

/**
 * What the index helpers read: the D1 connector catch-up index (shared with
 * integration-sync-worker). Without the binding every call is a no-op.
 */
export interface ConnectorSyncIndexEnv {
  CONNECTOR_SYNC_INDEX?: D1Database;
}

export async function upsertConnectorIndexFromRow(
  env: ConnectorSyncIndexEnv,
  args: {
    connection: ConnectorConnectionRow;
    workspaceId: string;
    clerkOrgId: string;
    enabled?: boolean;
  },
): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  const encrypted = args.connection.credentials;
  if (!encrypted || Object.keys(encrypted).length === 0) return;
  try {
    await upsertConnectorSyncIndex(d1, {
      connectionId: args.connection.id,
      workspaceId: args.workspaceId,
      clerkOrgId: args.clerkOrgId,
      provider: args.connection.provider,
      enabled: args.enabled ?? args.connection.status !== 'paused',
      encryptedCredentialsJson: JSON.stringify(encrypted),
      watermarks: args.connection.syncWatermarks ?? {},
      enabledSyncs: args.connection.enabledSyncs ?? null,
    });
  } catch (err) {
    console.warn(`[connector-sync-index] upsert failed for ${args.connection.id}:`, err);
  }
}

export async function setConnectorIndexEnabled(
  env: ConnectorSyncIndexEnv,
  connectionId: string,
  enabled: boolean,
): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    await setConnectorSyncIndexEnabled(d1, connectionId, enabled);
  } catch (err) {
    console.warn(`[connector-sync-index] enable/disable failed for ${connectionId}:`, err);
  }
}

export async function removeConnectorIndex(env: ConnectorSyncIndexEnv, connectionId: string): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    await deleteConnectorSyncIndex(d1, connectionId);
  } catch (err) {
    console.warn(`[connector-sync-index] delete failed for ${connectionId}:`, err);
  }
}

export async function touchConnectorIndexWebhook(
  env: ConnectorSyncIndexEnv,
  args: { connectionId: string; watermarks?: Record<string, string> | null },
): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    await touchConnectorSyncIndexWebhook(d1, args);
  } catch (err) {
    console.warn(`[connector-sync-index] webhook touch failed for ${args.connectionId}:`, err);
  }
}

export async function touchConnectorIndexIngested(
  env: ConnectorSyncIndexEnv,
  args: {
    connection: ConnectorConnectionRow;
    fingerprint?: Record<string, number> | null;
  },
): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    await markConnectorSyncIndexIngested(d1, {
      connectionId: args.connection.id,
      intervalMinutes: connectorIntervalMinutes(args.connection.provider),
      watermarks: args.connection.syncWatermarks ?? {},
      fingerprint: args.fingerprint,
    });
  } catch (err) {
    console.warn(`[connector-sync-index] ingest touch failed for ${args.connection.id}:`, err);
  }
}
