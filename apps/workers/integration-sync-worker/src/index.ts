/**
 * Integration Sync Scheduler Worker
 *
 * A lightweight cron-triggered worker that checks all workspaces for
 * integration connections due for sync, then triggers syncs via app-api's
 * service binding (internal router — see app-api routes/integrations/internal.ts).
 *
 * Provider-agnostic — works for CRM, e-commerce, and any future integration type.
 * Each connection's sync interval is user-configurable via syncSettings.syncIntervalHours.
 */

import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { eq, and, isNull } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as schema from '@weldsuite/db/schema';

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
}

/** Default sync interval if not configured (hours) */
const DEFAULT_INTERVAL_HOURS = 6;

/** Minimum sync interval to prevent abuse (hours) */
const MIN_INTERVAL_HOURS = 1;

/** Providers that support automatic sync */
const SYNCABLE_PROVIDERS = new Set([
  // CRM
  'attio', 'hubspot', 'salesforce', 'pipedrive',
  // Calendar
  'google_calendar',
  // E-commerce (future)
  // 'shopify', 'woocommerce',
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
  },
};
