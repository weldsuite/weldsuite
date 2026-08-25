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
import type { Env } from '../types';
import type { ConnectorConnectionRow } from '../services/connectors/connections';

export async function upsertConnectorIndexFromRow(
  env: Env,
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
  env: Env,
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

export async function removeConnectorIndex(env: Env, connectionId: string): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    await deleteConnectorSyncIndex(d1, connectionId);
  } catch (err) {
    console.warn(`[connector-sync-index] delete failed for ${connectionId}:`, err);
  }
}

export async function touchConnectorIndexWebhook(
  env: Env,
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
  env: Env,
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
