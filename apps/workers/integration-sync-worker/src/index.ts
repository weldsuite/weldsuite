/**
 * Integration Sync Scheduler Worker
 *
 * A lightweight cron-triggered worker that checks all workspaces for
 * integration connections due for sync, then triggers syncs via app-api's
 * service binding (internal router — see app-api routes/integrations/internal.ts).
 *
 * Ongoing updates do not use this worker. Ecommerce connectors register
 * store webhooks and ingest through integration-webhook-worker → app-api, so
 * tenant databases stay asleep until the store has new data.
 */

import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { and, eq, isNull, lte } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as schema from '@weldsuite/db/schema';
import { runConnectorCatchupSweep } from './connector-catchup';

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
  /** D1 connector catch-up index — due rows only; never scan tenant Neon. */
  CONNECTOR_SYNC_INDEX?: D1Database;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}

/** Default sync interval if not configured (hours) */
const DEFAULT_INTERVAL_HOURS = 6;

/** Minimum sync interval to prevent abuse (hours) */
const MIN_INTERVAL_HOURS = 1;

/** Providers that support automatic sync */
const SYNCABLE_PROVIDERS = new Set([
  // CRM — remaining pollers. Ecommerce connectors (WooCommerce, Shopify) are
  // webhook-only and must not sweep tenant databases on a timer.
  'attio', 'hubspot', 'salesforce', 'pipedrive',
  'google_calendar',
]);

function getMasterDb(env: Env) {
  const sql = neon(env.HYPERDRIVE_MASTER.connectionString);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

function getTenantDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzleNeonHttp({ client: sql, schema });
}

interface SyncSettings {
  syncIntervalHours?: number;
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    console.log(`[IntegrationScheduler] Starting sync check (${env.ENVIRONMENT})`);

    if (env.CONNECTOR_SYNC_INDEX) {
      try {
        const catchup = await runConnectorCatchupSweep(env.CONNECTOR_SYNC_INDEX, env);
        console.log(
          `[IntegrationScheduler] Connector catch-up. Skipped: ${catchup.skipped}, Probed: ${catchup.probed}, Ingested: ${catchup.ingested}, Backed off: ${catchup.backedOff}`,
        );
      } catch (err) {
        console.error('[IntegrationScheduler] Connector catch-up sweep failed:', err);
      }
    } else {
      console.warn('[IntegrationScheduler] CONNECTOR_SYNC_INDEX D1 binding not configured, skipping connector catch-up');
    }

    const masterDb = getMasterDb(env);

    // Load all active workspaces with their database URLs
    const workspaces = await masterDb
      .select({
        id: masterSchema.workspaces.id,
        clerkOrgId: masterSchema.workspaces.clerkOrgId,
        databaseUrl: masterSchema.workspaces.databaseUrl,
      })
      .from(masterSchema.workspaces)
      .where(isNull(masterSchema.workspaces.deletedAt));

    let totalTriggered = 0;
    let totalSkipped = 0;
    const now = new Date();

    for (const workspace of workspaces) {
      if (!workspace.clerkOrgId || !workspace.databaseUrl) continue;

      try {
        const db = getTenantDb(workspace.databaseUrl);

        const connections = await db
          .select()
          .from(schema.integrationConnections)
          .where(
            and(
              eq(schema.integrationConnections.status, 'active'),
              isNull(schema.integrationConnections.deletedAt),
            )
          );

        for (const connection of connections) {
          // Skip unsupported providers
          if (!SYNCABLE_PROVIDERS.has(connection.provider)) continue;

          // Skip connections without tokens
          const tokens = connection.oauthTokens as { accessToken: string } | null;
          if (!tokens?.accessToken) continue;

          // Check if sync is due
          const syncSettings = connection.syncSettings as SyncSettings | null;
          const intervalHours = Math.max(
            syncSettings?.syncIntervalHours || DEFAULT_INTERVAL_HOURS,
            MIN_INTERVAL_HOURS,
          );

          const lastSync = connection.lastSyncAt ? new Date(connection.lastSyncAt) : new Date(0);
          const nextSyncDue = new Date(lastSync.getTime() + intervalHours * 60 * 60 * 1000);

          if (now < nextSyncDue) {
            totalSkipped++;
            continue;
          }

          // Google Calendar: check if watch channel needs renewal (expires every ~7 days)
          if (connection.provider === 'google_calendar' && connection.webhookSecret) {
            try {
              const watchInfo = JSON.parse(connection.webhookSecret) as { expiration?: string };
              if (watchInfo.expiration) {
                const expiresAt = new Date(Number(watchInfo.expiration));
                const renewalBuffer = 24 * 60 * 60 * 1000; // 24 hours before expiry
                if (now.getTime() > expiresAt.getTime() - renewalBuffer) {
                  // Trigger watch channel renewal via app-api
                  const renewResponse = await env.APP_API.fetch(
                    `https://internal/api/integrations/connections/${connection.id}/renew-watch`,
                    {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'X-Workspace-Id': workspace.clerkOrgId,
                        'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
                      },
                    }
                  );
                  if (renewResponse.ok) {
                    console.log(`[IntegrationScheduler] Renewed Google Calendar watch for ${connection.id}`);
                  } else {
                    console.error(`[IntegrationScheduler] Watch renewal failed for ${connection.id}: ${renewResponse.status}`);
                  }
                }
              }
            } catch (err) {
              console.error(`[IntegrationScheduler] Watch renewal check failed for ${connection.id}:`, err);
            }
          }

          // Trigger sync via app-api service binding. No body → app-api's
          // internal router defaults syncType to 'full'.
          try {
            const response = await env.APP_API.fetch(
              `https://internal/api/integrations/connections/${connection.id}/sync`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  // Internal auth — app-api's internal integrations router matches
                  // X-Internal-Secret and resolves the tenant from X-Workspace-Id.
                  'X-Workspace-Id': workspace.clerkOrgId,
                  'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
                },
              }
            );

            if (response.ok) {
              totalTriggered++;
              console.log(`[IntegrationScheduler] Triggered ${connection.provider} sync for connection ${connection.id}`);
            } else {
              console.error(`[IntegrationScheduler] Failed to trigger sync for ${connection.id}: ${response.status}`);
            }
          } catch (err) {
            console.error(`[IntegrationScheduler] Error triggering sync for ${connection.id}:`, err);
          }
        }
      } catch (err) {
        console.error(`[IntegrationScheduler] Failed to process workspace ${workspace.id}:`, err);
      }
    }

    console.log(`[IntegrationScheduler] Done. Triggered: ${totalTriggered}, Skipped (not due): ${totalSkipped}`);

    // WeldAds: poll master ad_sync_index — only touch tenants with due connections.
    await runAdSyncSweep(env, masterDb, now);
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
