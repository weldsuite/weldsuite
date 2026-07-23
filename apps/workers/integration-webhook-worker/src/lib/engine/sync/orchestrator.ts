/**
 * CRM Sync Engine — Orchestrator
 *
 * Coordinates a sync run for a single entity type. Provider-agnostic —
 * uses the CrmSyncAdapter interface and field mappings from the database.
 * Called by the CrmSyncWorkflow steps.
 */

import { eq, and } from 'drizzle-orm';
import { schema } from '../../../db';
import { generateId } from '../../id';
import { FieldMapper } from './field-mapper';
import { ConflictResolver } from './conflict-resolver';
import { upsertByMapping } from './upsert';
import type {
  CrmSyncAdapter,
  SyncEntityType,
  SyncEntityStats,
  FieldMappingDefinition,
} from './types';
import type {
  ConflictStrategy,
  IntegrationConnection,
  IntegrationSyncCursor,
} from '@weldsuite/db/schema';

type TenantDb = Awaited<ReturnType<typeof import('../../../db').getTenantDbForWorkspace>>;

const THROTTLE_MS = 200;

/**
 * Compute SHA-256 checksum of a value for change detection.
 */
async function computeChecksum(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const encoded = new TextEncoder().encode(json);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Map SyncEntityType to the Drizzle table and entity prefix.
 */
function getEntityTable(entityType: SyncEntityType) {
  switch (entityType) {
    case 'customer':
      return { table: schema.companies, prefix: 'company', internalType: 'company' };
    case 'contact':
      return { table: schema.people, prefix: 'person', internalType: 'person' };
    case 'lead':
      return { table: schema.crmLeads, prefix: 'lead', internalType: 'lead' };
    case 'opportunity':
      return { table: schema.crmOpportunities, prefix: 'opp', internalType: 'opportunity' };
    case 'activity':
      return { table: schema.crmActivities, prefix: 'act', internalType: 'activity' };
    case 'calendar_event':
      return { table: schema.calendarEvents, prefix: 'evt', internalType: 'calendar_event' };
    case 'pipeline':
      return { table: schema.crmPipelines, prefix: 'pipe', internalType: 'pipeline' };
    default:
      throw new Error(`Unsupported entity type: ${entityType}`);
  }
}

/**
 * Load field mappings from the database for a connection + entity type.
 * Falls back to adapter defaults if no custom mappings exist.
 */
async function loadFieldMappings(
  db: TenantDb,
  connectionId: string,
  entityType: SyncEntityType,
  adapter: CrmSyncAdapter,
): Promise<FieldMappingDefinition[]> {
  const rows = await db
    .select()
    .from(schema.integrationFieldMappings)
    .where(
      and(
        eq(schema.integrationFieldMappings.connectionId, connectionId),
        eq(schema.integrationFieldMappings.entityType, entityType),
      )
    );

  if (rows.length > 0) {
    return rows.map(r => ({
      externalFieldPath: r.externalFieldPath,
      internalFieldPath: r.internalFieldPath,
      direction: r.direction,
      transformType: r.transformType,
      transformConfig: r.transformConfig ?? undefined,
      isRequired: r.isRequired,
    }));
  }

  // No custom mappings — return provider defaults
  return adapter.getDefaultFieldMappings(entityType);
}


export interface SyncOptions {
  /** Default values merged into every created/updated record (e.g. calendarId, organizerId) */
  defaultValues?: Record<string, unknown>;
}

/**
 * Sync a single entity type for a connection. Returns stats.
 */
export async function syncEntityType(
  db: TenantDb,
  adapter: CrmSyncAdapter,
  connection: IntegrationConnection,
  entityType: SyncEntityType,
  accessToken: string,
  options?: SyncOptions,
): Promise<SyncEntityStats> {
  const stats: SyncEntityStats = {
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    conflicts: 0,
  };

  const mappingDefs = await loadFieldMappings(db, connection.id, entityType, adapter);
  // When adapter returns no field mappings (e.g. Google Calendar uses hardcoded transforms),
  // entity.data is already in internal format — use it directly.
  const useDirectData = mappingDefs.length === 0;

  const fieldMapper = useDirectData ? null : new FieldMapper(mappingDefs);
  const conflictResolver = new ConflictResolver(
    (connection.conflictStrategy as ConflictStrategy) || 'last_write_wins'
  );

  const { prefix, internalType } = getEntityTable(entityType);

  // Load cursor for incremental sync
  const cursors = (connection.syncCursor as IntegrationSyncCursor) || {};
  let cursor = cursors[entityType] || undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await adapter.fetchEntities(accessToken, entityType, cursor);

    for (const entity of page.entities) {
      stats.processed++;

      try {
        const checksum = await computeChecksum(entity.raw);
        const mappedData = {
          ...(useDirectData ? entity.data : fieldMapper!.mapToInternal(entity.data)),
          ...options?.defaultValues,
        };

        const { table } = getEntityTable(entityType);

        // Bidirectional conflict resolution runs BEFORE the write. Inbound-only
        // syncs (the default, and what Attio uses) skip straight to the shared
        // upsert below — the same canonical write path the webhook ingress uses.
        const entityConfig = connection.entityConfig as Record<string, string> | null;
        const direction = entityConfig?.[entityType] || 'inbound';

        if (direction === 'bidirectional') {
          const [existingMapping] = await db
            .select()
            .from(schema.integrationEntityMappings)
            .where(
              and(
                eq(schema.integrationEntityMappings.connectionId, connection.id),
                eq(schema.integrationEntityMappings.externalEntityType, entityType),
                eq(schema.integrationEntityMappings.externalEntityId, entity.id),
              )
            )
            .limit(1);

          if (existingMapping && existingMapping.syncChecksum !== checksum) {
            const [internalRecord] = await db
              .select()
              .from(table)
              .where(eq(table.id, existingMapping.internalEntityId))
              .limit(1);

            if (internalRecord) {
              const internalData = internalRecord as Record<string, unknown>;
              const conflictFields = fieldMapper ? fieldMapper.detectConflicts(internalData, entity.data) : [];

              if (conflictFields.length > 0) {
                const resolution = conflictResolver.resolve(
                  new Date(String(internalData.updatedAt || 0)),
                  new Date(entity.updatedAt),
                );

                if (resolution.action === 'queue_manual') {
                  await db.insert(schema.integrationSyncConflicts).values({
                    id: generateId('cnfl'),
                    connectionId: connection.id,
                    entityType,
                    internalEntityId: existingMapping.internalEntityId,
                    externalEntityId: entity.id,
                    conflictType: 'field_mismatch',
                    internalData: internalData as Record<string, unknown>,
                    externalData: entity.data,
                    conflictFields,
                  });
                  stats.conflicts++;
                  continue;
                }

                if (resolution.action === 'use_internal') {
                  stats.skipped++;
                  continue;
                }
                // 'use_external' falls through to the shared upsert
              }
            }
          }
        }

        // Shared write path: mapping → checksum-skip → email dedup → create.
        const result = await upsertByMapping({
          db,
          connectionId: connection.id,
          externalEntityType: entityType,
          externalEntityId: entity.id,
          internalEntityType: internalType,
          table,
          idPrefix: prefix,
          values: mappedData,
          checksum,
        });
        if (result.action === 'created') stats.created++;
        else if (result.action === 'updated') stats.updated++;
        else stats.skipped++;
      } catch (err) {
        stats.failed++;
        console.error(`[SyncOrchestrator] Failed to sync ${entityType} ${entity.id}:`, err);
      }
    }

    // Update cursor
    cursor = page.nextCursor;
    hasMore = page.hasMore;

    if (hasMore) {
      await new Promise(r => setTimeout(r, THROTTLE_MS));
    }
  }

  // Persist cursor for next incremental sync
  const updatedCursors = { ...cursors, [entityType]: cursor || '' };
  await db
    .update(schema.integrationConnections)
    .set({ syncCursor: updatedCursors, updatedAt: new Date() })
    .where(eq(schema.integrationConnections.id, connection.id));

  return stats;
}
