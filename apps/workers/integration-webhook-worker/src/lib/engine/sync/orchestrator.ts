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
  ExternalEntity,
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

/** Everything the per-entity sync step needs, resolved once per sync run. */
interface EntitySyncContext {
  db: TenantDb;
  connection: IntegrationConnection;
  entityType: SyncEntityType;
  fieldMapper: FieldMapper | null;
  conflictResolver: ConflictResolver;
  defaultValues?: Record<string, unknown>;
  table: ReturnType<typeof getEntityTable>['table'];
  prefix: string;
  internalType: string;
}

/**
 * Bidirectional conflict resolution, run BEFORE the write. Returns 'conflict'
 * when the conflict was queued for manual review, 'skip' when the internal
 * version wins, and 'proceed' when the shared upsert should run.
 */
async function resolveBidirectionalConflict(
  ctx: EntitySyncContext,
  entity: ExternalEntity,
  checksum: string,
): Promise<'proceed' | 'conflict' | 'skip'> {
  const { db, connection, entityType, fieldMapper, conflictResolver, table } = ctx;

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

  if (!existingMapping || existingMapping.syncChecksum === checksum) return 'proceed';

  const [internalRecord] = await db
    .select()
    .from(table)
    .where(eq(table.id, existingMapping.internalEntityId))
    .limit(1);

  if (!internalRecord) return 'proceed';

  const internalData = internalRecord as Record<string, unknown>;
  const conflictFields = fieldMapper ? fieldMapper.detectConflicts(internalData, entity.data) : [];
  if (conflictFields.length === 0) return 'proceed';

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
    return 'conflict';
  }

  if (resolution.action === 'use_internal') return 'skip';
  // 'use_external' falls through to the shared upsert
  return 'proceed';
}

/**
 * Sync one external entity into the tenant DB and update the run stats.
 * Throws on failure; the caller counts it as failed.
 */
async function syncOneEntity(
  ctx: EntitySyncContext,
  entity: ExternalEntity,
  stats: SyncEntityStats,
): Promise<void> {
  const { db, connection, entityType, fieldMapper, defaultValues, table, prefix, internalType } = ctx;

  const checksum = await computeChecksum(entity.raw);
  const mappedData = {
    // No field mapper: entity.data is already in internal format.
    ...(fieldMapper ? fieldMapper.mapToInternal(entity.data) : entity.data),
    ...defaultValues,
  };

  // Inbound-only syncs (the default, and what Attio uses) skip straight to the shared
  // upsert below — the same canonical write path the webhook ingress uses.
  const entityConfig = connection.entityConfig as Record<string, string> | null;
  const direction = entityConfig?.[entityType] || 'inbound';

  if (direction === 'bidirectional') {
    const outcome = await resolveBidirectionalConflict(ctx, entity, checksum);
    if (outcome === 'conflict') {
      stats.conflicts++;
      return;
    }
    if (outcome === 'skip') {
      stats.skipped++;
      return;
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
  const fieldMapper = mappingDefs.length === 0 ? null : new FieldMapper(mappingDefs);
  const conflictResolver = new ConflictResolver(
    (connection.conflictStrategy as ConflictStrategy) || 'last_write_wins'
  );

  const { table, prefix, internalType } = getEntityTable(entityType);
  const ctx: EntitySyncContext = {
    db,
    connection,
    entityType,
    fieldMapper,
    conflictResolver,
    defaultValues: options?.defaultValues,
    table,
    prefix,
    internalType,
  };

  // Load cursor for incremental sync
  const cursors = (connection.syncCursor as IntegrationSyncCursor) || {};
  let cursor = cursors[entityType] || undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await adapter.fetchEntities(accessToken, entityType, cursor);

    for (const entity of page.entities) {
      stats.processed++;

      try {
        await syncOneEntity(ctx, entity, stats);
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
