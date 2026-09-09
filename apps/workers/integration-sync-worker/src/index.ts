/**
 * Integration Sync Scheduler Worker
 *
 * Cron every 15 minutes:
 * 1. D1 connector catch-up — probe stores, open tenant Neon only on hits
 * 2. D1 CRM due-index — trigger APP_API sync for due CRM connections only
 * 3. Master ad_sync_index — WeldAds metrics (due rows only)
 *
 * Quiet ticks never open tenant Neon for connectors or CRM.
 */

import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { and, eq, lte } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { runConnectorCatchupSweep } from './connector-catchup';
import { runCrmDueSweep } from './crm-due';

export interface Env {
  HYPERDRIVE_MASTER: Hyperdrive;
  /** app-api service binding (weldsuite-app-api[-test]) — internal routes only. */
  APP_API: Fetcher;
  ENVIRONMENT: string;
  /**
   * Must match the target app-api env's INTERNAL_API_SECRET. app-api's internal
   * integrations router fails closed with 401 on a missing/wrong secret, and the
   * failure branches below only log — a mismatch silently stops all auto-sync.
   */
  INTERNAL_API_SECRET?: string;
  /** D1 connector catch-up + CRM due index — never scan tenant Neon for due-ness. */
  CONNECTOR_SYNC_INDEX?: D1Database;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}

function getMasterDb(env: Env) {
  const sql = neon(env.HYPERDRIVE_MASTER.connectionString);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    if (env.CONNECTOR_SYNC_INDEX) {
      try {
        const catchup = await runConnectorCatchupSweep(env.CONNECTOR_SYNC_INDEX, env);
        console.log(
          `[IntegrationScheduler] Connector catch-up. Skipped: ${catchup.skipped}, Probed: ${catchup.probed}, Ingested: ${catchup.ingested}, Backed off: ${catchup.backedOff}`,
        );
      } catch (err) {
        console.error('[IntegrationScheduler] Connector catch-up sweep failed:', err);
      }

      try {
        const crm = await runCrmDueSweep(env.CONNECTOR_SYNC_INDEX, env);
        console.log(
          `[IntegrationScheduler] CRM due. Triggered: ${crm.triggered}, Renewed watches: ${crm.renewed}, Failed: ${crm.failed}`,
        );
      } catch (err) {
        console.error('[IntegrationScheduler] CRM due sweep failed:', err);
      }
    } else {
      console.warn('[IntegrationScheduler] CONNECTOR_SYNC_INDEX D1 binding not configured, skipping connector + CRM sweeps');
    }

    // WeldAds: poll master ad_sync_index — only touch tenants with due connections.
    const masterDb = getMasterDb(env);
    await runAdSyncSweep(env, masterDb, new Date());
  },
};

async function runAdSyncSweep(env: Env, masterDb: ReturnType<typeof getMasterDb>, now: Date) {
  const dueRows = await masterDb
    .select()
    .from(masterSchema.adSyncIndex)
    .where(
      and(
        eq(masterSchema.adSyncIndex.isEnabled, true),
        lte(masterSchema.adSyncIndex.nextMetricsSyncAt, now),
      ),
    )
    .limit(100);

  let triggered = 0;
  for (const row of dueRows) {
    if (!row.clerkOrgId) continue;
    try {
      const response = await env.APP_API.fetch(
        `https://internal/api/integrations/ad-connections/${row.connectionId}/sync?scope=full`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Workspace-Id': row.clerkOrgId,
            'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
          },
        },
      );
      if (response.ok) {
        triggered += 1;
        console.log(`[IntegrationScheduler] Triggered WeldAds sync for connection ${row.connectionId}`);
      } else {
        console.error(
          `[IntegrationScheduler] WeldAds sync failed for ${row.connectionId}: ${response.status}`,
        );
      }
    } catch (err) {
      console.error(`[IntegrationScheduler] WeldAds sync error for ${row.connectionId}:`, err);
    }
  }

  console.log(`[IntegrationScheduler] WeldAds sweep done. Triggered: ${triggered}`);
}
