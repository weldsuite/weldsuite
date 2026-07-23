/**
 * CrmSyncWorkflow — Cloudflare Workflow
 *
 * Replaces the Trigger.dev `crm-integration-sync` task.
 * Syncs CRM entities between WeldSuite and an external CRM provider
 * using the provider-agnostic sync engine.
 *
 * Each entity type syncs as a separate step for granular retries.
 * Uses connectionId as the workflow instance ID for dedup/cancellation.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env } from '../index';
import { getTenantDbForWorkspace, schema } from '../db';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { generateId } from '../lib/id';
import { getAdapter } from '../lib/engine/sync/registry';
import { syncEntityType, type SyncOptions } from '../lib/engine/sync/orchestrator';
import type { SyncEntityType, SyncEntityStats } from '../lib/engine/sync/types';
import type { IntegrationSyncSettings } from '@weldsuite/db/schema';

// Register adapters
import { AttioSyncAdapter } from '../lib/engine/adapters/attio';
import { HubSpotSyncAdapter } from '../lib/engine/adapters/hubspot';
import { GoogleCalendarSyncAdapter } from '../lib/engine/adapters/google-calendar';
import { registerAdapter } from '../lib/engine/sync/registry';
registerAdapter(new AttioSyncAdapter());
registerAdapter(new HubSpotSyncAdapter());
registerAdapter(new GoogleCalendarSyncAdapter());

export interface CrmSyncParams {
  workspaceId: string;
  connectionId: string;
  provider: string;
  syncType: 'full' | 'incremental';
  entityTypes?: SyncEntityType[];
}

/**
 * Determine which entity types are enabled for sync based on connection settings.
 */
function getEnabledEntityTypes(
  syncSettings: IntegrationSyncSettings | null,
  supportedEntities: SyncEntityType[],
): SyncEntityType[] {
  if (!syncSettings) return supportedEntities;

  const enabled: SyncEntityType[] = [];
  if (syncSettings.syncCompanies !== false) enabled.push('customer');
  if (syncSettings.syncPeople !== false) enabled.push('contact');
  if (syncSettings.syncLeads) enabled.push('lead');
  if (syncSettings.syncOpportunities) enabled.push('opportunity');
  if (syncSettings.syncActivities) enabled.push('activity');
  if (syncSettings.syncCalendarEvents !== false) enabled.push('calendar_event');

  return enabled.filter(e => supportedEntities.includes(e));
}

export class CrmSyncWorkflow extends WorkflowEntrypoint<Env, CrmSyncParams> {
  async run(event: WorkflowEvent<CrmSyncParams>, step: WorkflowStep) {
    const { workspaceId, connectionId, provider, syncType, entityTypes: requestedTypes } = event.payload;

    // Declared outside the try so the failure handler can finalize the log.
    let syncLogId: string | undefined;

    try {
    // Step 1: Load connection and validate
    const connectionData = await step.do('load-connection', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);

      const [connection] = await db
        .select()
        .from(schema.integrationConnections)
        .where(
          and(
            eq(schema.integrationConnections.id, connectionId),
            isNull(schema.integrationConnections.deletedAt),
          )
        )
        .limit(1);

      if (!connection) {
        throw new Error(`Connection ${connectionId} not found`);
      }

      const tokens = connection.oauthTokens as { accessToken: string; refreshToken?: string; expiresAt?: string } | null;
      if (!tokens?.accessToken) {
        throw new Error(`No access token for connection ${connectionId}`);
      }

      // Check if token needs refresh
      if (tokens.expiresAt && new Date(tokens.expiresAt) < new Date()) {
        if (!tokens.refreshToken) {
          throw new Error(`Token expired and no refresh token available for ${connectionId}`);
        }

        const adapter = getAdapter(provider);
        const creds = this.env as unknown as Record<string, string | undefined>;
        const clientId = creds[`${provider.toUpperCase()}_CLIENT_ID`] || this.env.ATTIO_CLIENT_ID;
        const clientSecret = creds[`${provider.toUpperCase()}_CLIENT_SECRET`] || this.env.ATTIO_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new Error(`Missing OAuth client credentials for provider ${provider}`);
        }

        const newTokens = await adapter.refreshAccessToken(clientId, clientSecret, tokens.refreshToken);

        await db
          .update(schema.integrationConnections)
          .set({ oauthTokens: newTokens, updatedAt: new Date() })
          .where(eq(schema.integrationConnections.id, connectionId));

        return {
          connection,
          accessToken: newTokens.accessToken,
        };
      }

      return {
        connection,
        accessToken: tokens.accessToken,
      };
    });

    // Step 2: Create sync log and update connection status
    const logId = await step.do('create-sync-log', async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      const id = generateId('slog');

      await db.insert(schema.syncLogs).values({
        id,
        platform: provider as any,
        connectionId,
        syncType: 'all',
        status: 'running',
        triggeredBy: syncType === 'full' ? 'manual' : 'scheduled',
        startedAt: new Date(),
      });

      await db
        .update(schema.integrationConnections)
        .set({ status: 'syncing', updatedAt: new Date() })
        .where(eq(schema.integrationConnections.id, connectionId));

      return id;
    });
    // Expose to the failure handler (which lives outside this try-scoped const).
    syncLogId = logId;

    // Step 3: Sync each entity type
    const adapter = getAdapter(provider);
    const entityTypes = requestedTypes || getEnabledEntityTypes(
      connectionData.connection.syncSettings as IntegrationSyncSettings | null,
      adapter.supportedEntities,
    );

    const allStats: Record<string, SyncEntityStats> = {};
    const startTime = Date.now();

    for (const entityType of entityTypes) {
      allStats[entityType] = await step.do(`sync-${entityType}`, {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      }, async () => {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);

        // Re-load connection to get latest cursor state
        const [connection] = await db
          .select()
          .from(schema.integrationConnections)
          .where(eq(schema.integrationConnections.id, connectionId))
          .limit(1);

        if (!connection) {
          throw new Error(`Connection ${connectionId} not found during sync`);
        }

        // For calendar_event, inject required fields not present in Google data
        const syncOptions: SyncOptions | undefined =
          entityType === 'calendar_event'
            ? {
                defaultValues: {
                  calendarId: (connection.settings as Record<string, unknown>)?.googleCalendarId,
                  organizerId: connection.connectedBy,
                  type: 'event',
                },
              }
            : undefined;

        return await syncEntityType(
          db,
          adapter,
          connection,
          entityType,
          connectionData.accessToken,
          syncOptions,
        );
      });
    }

    // Step 4: Finalize — update sync log and connection stats
    await step.do('finalize', async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      const durationMs = Date.now() - startTime;

      let totalProcessed = 0;
      let totalCreated = 0;
      let totalUpdated = 0;
      let totalFailed = 0;
      let totalSkipped = 0;

      for (const stats of Object.values(allStats)) {
        totalProcessed += stats.processed;
        totalCreated += stats.created;
        totalUpdated += stats.updated;
        totalFailed += stats.failed;
        totalSkipped += stats.skipped;
      }

      await db
        .update(schema.syncLogs)
        .set({
          status: 'completed',
          itemsProcessed: totalProcessed,
          totalItems: totalProcessed,
          itemsCreated: totalCreated,
          itemsUpdated: totalUpdated,
          itemsFailed: totalFailed,
          itemsSkipped: totalSkipped,
          finishedAt: new Date(),
          durationMs,
          metadata: allStats as unknown as Record<string, unknown>,
        })
        .where(eq(schema.syncLogs.id, logId));

      const statUpdates: Record<string, unknown> = {
        status: 'active',
        lastSyncAt: new Date(),
        lastSyncStatus: 'completed',
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      };

      if (allStats.customer) statUpdates.companiesSynced = allStats.customer.processed;
      if (allStats.contact) statUpdates.peopleSynced = allStats.contact.processed;
      if (allStats.lead) statUpdates.leadsSynced = allStats.lead.processed;
      if (allStats.opportunity) statUpdates.opportunitiesSynced = allStats.opportunity.processed;
      if (allStats.activity) statUpdates.activitiesSynced = allStats.activity.processed;
      if (allStats.calendar_event) statUpdates.activitiesSynced = allStats.calendar_event.processed;

      await db
        .update(schema.integrationConnections)
        .set(statUpdates)
        .where(eq(schema.integrationConnections.id, connectionId));

      console.log(`[CrmSync] Completed: ${totalProcessed} processed, ${totalCreated} created, ${totalUpdated} updated, ${totalFailed} failed (${durationMs}ms)`);

      // Publish realtime event so frontends refresh their calendar views
      const calStats = allStats.calendar_event;
      if (calStats && (calStats.created > 0 || calStats.updated > 0) && this.env.REALTIME) {
        try {
          const realtime = new RealtimePublisher(this.env.REALTIME);
          await realtime.publish(
            workspaceId,
            'calendar_event',
            'updated',
            { id: 'bulk_sync', syncStats: calStats },
            'system',
          );
        } catch (err) {
          console.error('[CrmSync] Failed to publish realtime calendar event:', err);
        }
      }
    });
    } catch (workflowErr) {
      // Any step that exhausts its retries lands here. Without this the
      // connection is left stuck in 'syncing' forever and the next manual
      // sync is rejected with "A sync is already in progress".
      const message = workflowErr instanceof Error ? workflowErr.message : String(workflowErr);
      console.error(`[CrmSync] Sync failed for connection ${connectionId}: ${message}`);

      await step.do('handle-failure', async () => {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);

        if (syncLogId) {
          await db
            .update(schema.syncLogs)
            .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
            .where(eq(schema.syncLogs.id, syncLogId));
        }

        await db
          .update(schema.integrationConnections)
          .set({
            status: 'error',
            lastSyncStatus: 'failed',
            lastError: message,
            lastErrorAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.integrationConnections.id, connectionId));
      });

      // Re-throw so the Workflow run is recorded as failed.
      throw workflowErr;
    }
  }
}
