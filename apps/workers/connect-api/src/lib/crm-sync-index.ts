/**
 * D1 crm_sync_index (app-api side) — schedule CRM OAuth syncs without tenant scans.
 */

import {
  deleteCrmSyncIndex,
  normalizeCrmIntervalMinutes,
  setCrmSyncIndexEnabled,
  upsertCrmSyncIndex,
} from '@weldsuite/connectors';
import type { Env } from '../types';

const CRM_INDEX_PROVIDERS = new Set([
  'attio',
  'hubspot',
  'salesforce',
  'pipedrive',
  'google_calendar',
]);

export function isCrmIndexProvider(provider: string): boolean {
  return CRM_INDEX_PROVIDERS.has(provider);
}

export async function upsertCrmIndex(args: {
  env: Env;
  connectionId: string;
  workspaceId: string;
  clerkOrgId: string;
  provider: string;
  enabled?: boolean;
  syncIntervalHours?: number | null;
  renewWatchAt?: number | null;
  dueNow?: boolean;
}): Promise<void> {
  const d1 = args.env.CONNECTOR_SYNC_INDEX;
  if (!d1 || !isCrmIndexProvider(args.provider)) return;
  try {
    await upsertCrmSyncIndex(d1, {
      connectionId: args.connectionId,
      workspaceId: args.workspaceId,
      clerkOrgId: args.clerkOrgId,
      provider: args.provider,
      enabled: args.enabled ?? true,
      intervalMinutes: normalizeCrmIntervalMinutes(args.syncIntervalHours),
      renewWatchAt: args.renewWatchAt,
      dueNow: args.dueNow,
    });
  } catch (err) {
    console.warn(`[crm-sync-index] upsert failed for ${args.connectionId}:`, err);
  }
}

export async function setCrmIndexEnabled(
  env: Env,
  connectionId: string,
  enabled: boolean,
): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    await setCrmSyncIndexEnabled(d1, connectionId, enabled);
  } catch (err) {
    console.warn(`[crm-sync-index] enable/disable failed for ${connectionId}:`, err);
  }
}

export async function removeCrmIndex(env: Env, connectionId: string): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    await deleteCrmSyncIndex(d1, connectionId);
  } catch (err) {
    console.warn(`[crm-sync-index] delete failed for ${connectionId}:`, err);
  }
}
