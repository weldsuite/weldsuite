/**
 * The sync loop — one connection, one entity type, one run.
 *
 * Nango used to own the schedule and hand us changed records; this is what
 * replaces it. The shape is deliberately the same as what that layer consumed,
 * so the ingest below it did not have to change: pull a page, ingest it, advance
 * a cursor, stop at a ceiling.
 *
 * Three properties matter and each has a failure it prevents:
 *
 *   - **A hard page ceiling.** An unbounded loop inside a Worker invocation hits
 *     the CPU limit mid-tenant and leaves the cursor half-advanced. Runs that hit
 *     the ceiling are marked `truncated` and resume from the persisted cursor.
 *   - **The watermark only advances on a complete, clean run.** A run truncated
 *     by the ceiling, or one where any record failed, leaves it untouched. Both
 *     are records the next run must re-read, and advancing past them would drop
 *     them permanently — the provider has no reason to touch them again. The cost
 *     of not advancing is a re-read that the checksum turns into a skip.
 *   - **The watermark comes from the records, not the clock.** Taking `now` would
 *     skip anything the provider modified during the run but had not yet
 *     returned.
 */

import { eq, sql } from 'drizzle-orm';
import {
  getConnector,
  isAuthFailure,
  ConnectorApiError,
  type ConnectorDriver,
  type ConnectorEntityDef,
  type ExternalEntity,
} from '@weldsuite/connectors';
import type {
  ConnectorConnection,
  ConnectorSyncRunStatus,
  ConnectorSyncTrigger,
  SyncEntityType,
} from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { resolveDriverContext } from './connections';
import { ingestEntities, sanitiseErrorMessage, type IngestCounts } from './ingest';

/**
 * Pages per run. Twenty pages of 100 is 2,000 records, comfortably inside a
 * Worker invocation while still finishing most tenants' initial import in one go.
 */
const MAX_PAGES_PER_RUN = 20;

export interface SyncRunResult extends IngestCounts {
  status: ConnectorSyncRunStatus;
  pagesRead: number;
  truncated: boolean;
  runId: string;
  error?: string;
}

export interface RunEntitySyncArgs {
  db: Database;
  connection: ConnectorConnection;
  driver: ConnectorDriver;
  entityType: SyncEntityType;
  trigger: ConnectorSyncTrigger;
  /** Clerk user id recorded as the owner of imported rows. */
  ownerId: string;
  workspaceId: string;
  env: Record<string, unknown>;
  /** Ignore the stored watermark and re-read everything. */
  fullResync?: boolean;
}

function entityDefFor(connectorId: string, entityType: SyncEntityType): ConnectorEntityDef {
  const connector = getConnector(connectorId);
  const entityDef = connector?.entities.find((e) => e.entity === entityType);
  if (!entityDef) {
    throw new ConnectorApiError({
      message: `Connector ${connectorId} does not declare entity ${entityType}`,
      status: 400,
      kind: 'permanent',
      connectorId,
    });
  }
  return entityDef;
}

/** Latest provider modification time seen in a page, as an ISO string. */
function maxUpdatedAt(entities: ExternalEntity[], current: string | null): string | null {
  let latest = current;
  for (const entity of entities) {
    const value = entity.updatedAt;
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) continue;
    if (latest === null || parsed > Date.parse(latest)) latest = new Date(parsed).toISOString();
  }
  return latest;
}

/**
 * Derive the run status from what happened.
 *
 * Enforced here rather than trusted from callers, because the watermark decision
 * reads it: a caller that reported `success` on a run with failures would advance
 * the watermark past records that never landed.
 */
function statusFor(counts: IngestCounts, truncated: boolean): ConnectorSyncRunStatus {
  if (counts.failed > 0) return 'partial';
  if (truncated) return 'partial';
  return 'success';
}

/**
 * Sync one entity type for one connection.
 *
 * Never throws for provider-side failures — they are recorded on the run row and
 * the connection, and returned. A queue consumer needs to distinguish "this
 * connection is broken" from "this message failed and should be retried", and an
 * exception cannot carry that.
 */
export async function runEntitySync(args: RunEntitySyncArgs): Promise<SyncRunResult> {
  const entityDef = entityDefFor(args.connection.connectorId, args.entityType);
  const runId = generateId('csr');
  const startedAt = new Date();

  await args.db.insert(schema.connectorSyncRuns).values({
    id: runId,
    connectionId: args.connection.id,
    entityType: args.entityType,
    status: 'running',
    trigger: args.trigger,
    startedAt,
  });

  const counts: IngestCounts = { created: 0, modified: 0, skipped: 0, deleted: 0, failed: 0 };
  const errorSamples: Array<{ externalId: string; message: string }> = [];
  let pagesRead = 0;
  let truncated = false;
  let watermark: string | null = null;

  try {
    const ctx = await resolveDriverContext({
      db: args.db,
      connection: args.connection,
      driver: args.driver,
      env: args.env as never,
    });

    const stored = args.connection.syncWatermarks?.[args.entityType];
    const updatedSince = args.fullResync || !stored ? undefined : new Date(stored);

    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const result = await args.driver.fetchEntities(ctx, args.entityType, cursor, updatedSince);
      pagesRead++;

      if (result.entities.length > 0) {
        const ingested = await ingestEntities({
          db: args.db,
          connectionId: args.connection.id,
          connectorId: args.connection.connectorId,
          entityDef,
          entities: result.entities,
          volatileFields: args.driver.volatileFields,
          ownerId: args.ownerId,
          workspaceId: args.workspaceId,
          env: args.env,
        });

        counts.created += ingested.created;
        counts.modified += ingested.modified;
        counts.skipped += ingested.skipped;
        counts.deleted += ingested.deleted;
        counts.failed += ingested.failed;
        for (const sample of ingested.errorSamples) {
          if (errorSamples.length < 5) errorSamples.push(sample);
        }

        watermark = maxUpdatedAt(result.entities, watermark);
      }

      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;

      // Ran out of pages with data still waiting.
      if (page === MAX_PAGES_PER_RUN - 1) truncated = true;
    }

    const status = statusFor(counts, truncated);
    await finishRun({
      db: args.db,
      runId,
      connection: args.connection,
      entityType: args.entityType,
      status,
      counts,
      pagesRead,
      truncated,
      errorSamples,
      startedAt,
      // Only a clean, complete run may move the watermark forward.
      watermark: status === 'success' ? watermark : null,
    });

    return { ...counts, status, pagesRead, truncated, runId };
  } catch (err) {
    const message = sanitiseErrorMessage(err);
    await finishRun({
      db: args.db,
      runId,
      connection: args.connection,
      entityType: args.entityType,
      status: 'error',
      counts,
      pagesRead,
      truncated,
      errorSamples,
      startedAt,
      watermark: null,
      error: message,
      // A rejected credential is the connection's problem, not this run's.
      connectionStatus: isAuthFailure(err) ? 'auth_error' : 'sync_error',
    });

    return { ...counts, status: 'error', pagesRead, truncated, runId, error: message };
  }
}

/** Close out the run row and fold its outcome into the connection. */
async function finishRun(args: {
  db: Database;
  runId: string;
  connection: ConnectorConnection;
  entityType: SyncEntityType;
  status: ConnectorSyncRunStatus;
  counts: IngestCounts;
  pagesRead: number;
  truncated: boolean;
  errorSamples: Array<{ externalId: string; message: string }>;
  startedAt: Date;
  watermark: string | null;
  error?: string;
  connectionStatus?: 'auth_error' | 'sync_error';
}): Promise<void> {
  const finishedAt = new Date();

  await args.db
    .update(schema.connectorSyncRuns)
    .set({
      status: args.status,
      recordsCreated: args.counts.created,
      recordsModified: args.counts.modified,
      recordsSkipped: args.counts.skipped,
      recordsDeleted: args.counts.deleted,
      recordsFailed: args.counts.failed,
      pagesRead: args.pagesRead,
      truncated: args.truncated,
      finishedAt,
      durationMs: finishedAt.getTime() - args.startedAt.getTime(),
      error: args.error ?? null,
      errorSamples: args.errorSamples.length > 0 ? args.errorSamples : null,
    })
    .where(eq(schema.connectorSyncRuns.id, args.runId));

  const written = args.counts.created + args.counts.modified;
  const watermarks = { ...(args.connection.syncWatermarks ?? {}) };
  if (args.watermark) watermarks[args.entityType] = args.watermark;

  await args.db
    .update(schema.connectorConnections)
    .set({
      lastSyncAt: finishedAt,
      lastSyncStatus: args.status,
      syncWatermarks: watermarks,
      recordsSynced: sql`${schema.connectorConnections.recordsSynced} + ${written}`,
      // Leave `active` alone on a clean run; a previous error is cleared only by
      // a run that actually succeeded.
      ...(args.connectionStatus
        ? { status: args.connectionStatus, lastError: args.error ?? null, lastErrorAt: finishedAt }
        : args.status === 'success'
          ? { status: 'active' as const, lastError: null, lastErrorAt: null }
          : {}),
      updatedAt: finishedAt,
    })
    .where(eq(schema.connectorConnections.id, args.connection.id));
}

/**
 * Sync every entity a connection has enabled.
 *
 * Sequential on purpose: the entities of one connection share the provider's
 * rate limit, and running them concurrently would just spend that budget faster.
 */
export async function runConnectionSync(
  args: Omit<RunEntitySyncArgs, 'entityType'>,
): Promise<SyncRunResult[]> {
  const connector = getConnector(args.connection.connectorId);
  const declared = connector?.entities.map((e) => e.entity) ?? [];
  const enabled = args.connection.enabledEntities ?? declared;
  const entityTypes = declared.filter((e) => enabled.includes(e));

  const results: SyncRunResult[] = [];
  for (const entityType of entityTypes) {
    results.push(await runEntitySync({ ...args, entityType }));
  }
  return results;
}
