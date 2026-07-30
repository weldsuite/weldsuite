/**
 * Connector ingest — the single write path from a provider into WeldSuite.
 *
 * One page of records at a time, so a Worker invocation never holds an unbounded
 * set in memory. Each record follows the same three steps:
 *
 *   1. Existing `integration_entity_mappings` row?  checksum match → skip,
 *      otherwise update the internal row.
 *   2. No mapping → dedup on a natural key (email) → link + update.
 *   3. No match → create + record the mapping.
 *
 * Reusing `integration_entity_mappings` keeps one mapping table for every
 * connector, so an entity synced by two of them is deduped against the same rows
 * and a future consolidation does not have to reconcile separate histories.
 *
 * Tenant isolation: `db` is already the tenant database resolved from the
 * connection's workspace. Nothing here takes a workspace id, so there is no code
 * path that could address another tenant's rows.
 *
 * Each entity write and its mapping write commit together — see `atomically`.
 * neon-http has no interactive transactions, so this goes through `db.batch()`,
 * which Neon runs as one transaction per HTTP request.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import {
  recordChecksum,
  getConnector,
  type ConnectorEntityDef,
  type ExternalEntity,
  type SyncEntityType,
} from '@weldsuite/connectors';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { mapExternalRecord, type MappedEntity } from './mappers';

// ============================================================================
// Types
// ============================================================================

export interface IngestCounts {
  created: number;
  modified: number;
  skipped: number;
  deleted: number;
  failed: number;
}

export interface IngestResult extends IngestCounts {
  errorSamples: Array<{ externalId: string; message: string }>;
}

export interface IngestArgs {
  db: Database;
  /** Local `connector_connections.id` — the mapping-table key. */
  connectionId: string;
  connectorId: string;
  entityDef: ConnectorEntityDef;
  entities: ExternalEntity[];
  /** Top-level keys to drop before checksumming, from `driver.volatileFields`. */
  volatileFields?: readonly string[];
  /** Clerk user id recorded as the owner of newly imported rows. */
  ownerId: string;
  /** Passed through to entity events so downstream sinks see the tenant. */
  workspaceId: string;
  env: Record<string, unknown>;
}

/** Only the first few failures are stored — enough to see the shape of a bad import. */
const MAX_ERROR_SAMPLES = 5;

/** Longest error text we keep per record. */
const MAX_ERROR_MESSAGE_LENGTH = 200;

// ============================================================================
// Helpers
// ============================================================================

function emptyCounts(): IngestCounts {
  return { created: 0, modified: 0, skipped: 0, deleted: 0, failed: 0 };
}

/**
 * Strip customer data out of a driver error before it is logged or persisted.
 *
 * Postgres embeds the offending value in its messages — `Key (email)=(jelle@
 * acme.example) already exists` — and these strings land in
 * `connector_sync_runs` and are rendered in the WeldConnect UI. The column name
 * is the diagnostic worth keeping; the value is the tenant's contact data.
 */
export function sanitiseErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    // `Key (col)=(value)` → `Key (col)=(redacted)`
    .replace(/\(([^)]*)\)=\([^)]*\)/g, '($1)=(redacted)')
    // Quoted literals in a failing statement.
    .replace(/'[^']*'/g, "'redacted'")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Table, id prefix, dedup column and event type for a synced entity.
 *
 * Throwing for an unmapped entity is deliberate: the catalog is only allowed to
 * declare entities that have a mapper, so reaching this branch means the catalog
 * and this file disagree and every record would silently vanish otherwise.
 */
function targetFor(entity: SyncEntityType): {
  table: PgTable;
  idPrefix: string;
  dedupColumn: string | null;
  eventEntityType: string;
} {
  switch (entity) {
    case 'customer':
      return {
        table: schema.accountingContacts,
        idPrefix: 'acn',
        dedupColumn: 'email',
        eventEntityType: 'accounting_contact',
      };
    default:
      throw new Error(`No ingest target configured for entity type: ${entity}`);
  }
}

/** Look up the mapping row for an external record, if we have one. */
async function findMapping(
  db: Database,
  connectionId: string,
  externalEntityType: string,
  externalEntityId: string,
): Promise<{ id: string; internalEntityId: string } | null> {
  const [row] = await db
    .select({
      id: schema.integrationEntityMappings.id,
      internalEntityId: schema.integrationEntityMappings.internalEntityId,
    })
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, externalEntityType),
        eq(schema.integrationEntityMappings.externalEntityId, externalEntityId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the internal id a mapped record's parent reference points at.
 *
 * Sync order across entities is not guaranteed, so an unresolved parent is
 * normal on a first run — the next run links it once the parent's own sync has
 * written its mapping.
 */
async function resolveParentInternalId(
  db: Database,
  connectionId: string,
  connectorId: string,
  mapped: MappedEntity,
): Promise<string | null> {
  if (!mapped.parentExternalId || !mapped.parentEntity) return null;
  const connector = getConnector(connectorId);
  const parentDef = connector?.entities.find((e) => e.entity === mapped.parentEntity);
  if (!parentDef) return null;

  const mapping = await findMapping(
    db,
    connectionId,
    parentDef.externalEntityType,
    mapped.parentExternalId,
  );
  return mapping?.internalEntityId ?? null;
}

/**
 * Commit related writes as one unit.
 *
 * An entity row and its `integration_entity_mappings` row must land together.
 * Split across two statements, a Worker dying in between leaves a row with no
 * mapping — and the next delivery re-creates it, which for any entity without a
 * natural dedup key is an unbounded duplicate per retry.
 *
 * The tenant DB is neon-http, which has no interactive transactions
 * (`db.transaction()` throws "No transactions support"). It does have
 * `db.batch()`, which Neon executes as a single transaction in one HTTP request
 * — the guarantee we need. Drivers with it the other way round (pglite, which
 * the tests use) fall back to a real transaction, so both paths are atomic and
 * the tests exercise the production semantics rather than a weaker stand-in.
 *
 * `build` is called with the handle to construct against. Drizzle query builders
 * are lazy, so building does not execute.
 */
async function atomically(db: Database, build: (handle: Database) => unknown[]): Promise<void> {
  const driver = db as unknown as {
    batch?: (items: unknown[]) => Promise<unknown>;
    transaction?: (fn: (tx: Database) => Promise<void>) => Promise<void>;
  };

  if (typeof driver.batch === 'function') {
    await driver.batch(build(db));
    return;
  }
  if (typeof driver.transaction === 'function') {
    await driver.transaction(async (tx) => {
      for (const statement of build(tx)) await (statement as Promise<unknown>);
    });
    return;
  }
  // No driver we know of lands here; sequential is strictly better than throwing.
  for (const statement of build(db)) await (statement as Promise<unknown>);
}

// ============================================================================
// Upsert
// ============================================================================

interface UpsertOutcome {
  action: 'created' | 'updated' | 'skipped';
  internalId: string;
}

async function upsertByMapping(args: {
  db: Database;
  connectionId: string;
  externalEntityType: string;
  externalEntityId: string;
  internalEntityType: string;
  table: PgTable;
  idPrefix: string;
  dedupColumn: string | null;
  values: Record<string, unknown>;
  checksum: string;
}): Promise<UpsertOutcome> {
  const { db, connectionId, externalEntityType, externalEntityId, internalEntityType } = args;
  // Column refs are resolved at runtime — the ingest is generic across tables.
  const cols = args.table as unknown as Record<string, never>;

  const [mapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, externalEntityType),
        eq(schema.integrationEntityMappings.externalEntityId, externalEntityId),
      ),
    )
    .limit(1);

  if (mapping) {
    if (mapping.syncChecksum === args.checksum) {
      return { action: 'skipped', internalId: mapping.internalEntityId };
    }
    // Atomic: if the checksum landed without the row update, the next delivery
    // would match the checksum and skip — the update lost forever.
    await atomically(db, (h) => [
      h
        .update(args.table)
        // `deletedAt: null` resurrects a row we previously soft-deleted for a
        // provider delete — the mapping survived, so an undelete lands here.
        .set({ ...args.values, deletedAt: null, updatedAt: new Date() } as never)
        .where(eq(cols.id, mapping.internalEntityId)),
      h
        .update(schema.integrationEntityMappings)
        .set({ syncChecksum: args.checksum, lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.integrationEntityMappings.id, mapping.id)),
    ]);
    return { action: 'updated', internalId: mapping.internalEntityId };
  }

  const dedupValue = args.dedupColumn ? (args.values[args.dedupColumn] as string | undefined) : undefined;
  if (args.dedupColumn && dedupValue && cols[args.dedupColumn]) {
    // Oldest row wins. `email` is not unique on these tables (shared info@
    // addresses are common), and without an ORDER BY the row we overwrite would
    // be whatever Postgres happened to return first — non-deterministic, and
    // destructive since the provider's values are written over it.
    const [match] = await db
      .select({ id: cols.id })
      .from(args.table)
      .where(and(eq(cols[args.dedupColumn], dedupValue), isNull(cols.deletedAt)))
      .orderBy(asc(cols.createdAt), asc(cols.id))
      .limit(1);

    if (match) {
      await atomically(db, (h) => [
        h.insert(schema.integrationEntityMappings).values({
          id: generateId('iem'),
          connectionId,
          externalEntityType,
          externalEntityId,
          internalEntityType,
          internalEntityId: match.id,
          lastSyncedAt: new Date(),
          syncChecksum: args.checksum,
        }),
        h
          .update(args.table)
          .set({ ...args.values, updatedAt: new Date() } as never)
          .where(eq(cols.id, match.id)),
      ]);
      return { action: 'updated', internalId: match.id };
    }
  }

  // The branch the atomicity matters most for: a row created without its
  // mapping is re-created on every redelivery.
  const newId = generateId(args.idPrefix);
  await atomically(db, (h) => [
    h.insert(args.table).values({ id: newId, ...args.values } as never),
    h.insert(schema.integrationEntityMappings).values({
      id: generateId('iem'),
      connectionId,
      externalEntityType,
      externalEntityId,
      internalEntityType,
      internalEntityId: newId,
      lastSyncedAt: new Date(),
      syncChecksum: args.checksum,
    }),
  ]);
  return { action: 'created', internalId: newId };
}

/**
 * Soft-delete the internal row behind a deleted external record.
 *
 * The mapping row is kept: if the record comes back (a provider "undelete", or a
 * filter change that re-includes it) it re-links to the same internal row
 * instead of creating a duplicate.
 *
 * Its checksum is cleared, though. Providers typically resend an undeleted
 * record byte-identical to what we last saw, so leaving the checksum in place
 * would make the next delivery match and return `skipped` — `deletedAt` would
 * never be cleared and the "it comes back" promise above would be a lie.
 * Nulling it forces that delivery down the update path, which resurrects the row.
 */
async function softDeleteMapped(
  db: Database,
  table: PgTable,
  internalId: string,
  mappingId: string,
): Promise<void> {
  const cols = table as unknown as Record<string, never>;
  // Atomic: a cleared checksum without the soft delete would re-import the
  // record as an update; a soft delete without the cleared checksum would make
  // the undelete unreachable.
  await atomically(db, (h) => [
    h
      .update(table)
      .set({ deletedAt: new Date(), updatedAt: new Date() } as never)
      .where(eq(cols.id, internalId)),
    h
      .update(schema.integrationEntityMappings)
      .set({ syncChecksum: null, lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.integrationEntityMappings.id, mappingId)),
  ]);
}

// ============================================================================
// Ingest
// ============================================================================

/**
 * Ingest one page of records into the tenant database.
 *
 * A record that fails is counted and skipped — one malformed row from a provider
 * must not abort the other 99 in the page.
 */
export async function ingestEntities(args: IngestArgs): Promise<IngestResult> {
  const counts = emptyCounts();
  const errorSamples: IngestResult['errorSamples'] = [];
  const target = targetFor(args.entityDef.entity);

  for (const entity of args.entities) {
    const externalId = entity.id;
    if (!externalId) {
      counts.skipped++;
      continue;
    }

    try {
      if (entity.isDeleted) {
        const mapping = await findMapping(
          args.db,
          args.connectionId,
          args.entityDef.externalEntityType,
          externalId,
        );
        if (mapping) {
          const internalId = mapping.internalEntityId;
          await softDeleteMapped(args.db, target.table, internalId, mapping.id);
          counts.deleted++;
          await publishEntityEventRaw({
            env: args.env as never,
            db: args.db as never,
            workspaceId: args.workspaceId,
            userId: args.ownerId,
            entityType: target.eventEntityType as never,
            action: 'deleted',
            entityId: internalId,
            data: { id: internalId },
          });
        } else {
          counts.skipped++;
        }
        continue;
      }

      const mapped = mapExternalRecord(args.connectorId, args.entityDef.entity, entity.data);
      if (!mapped) {
        counts.skipped++;
        continue;
      }

      const values: Record<string, unknown> = { ...mapped.values };

      if (mapped.parentEntity) {
        const parentInternalId = await resolveParentInternalId(
          args.db,
          args.connectionId,
          args.connectorId,
          mapped,
        );
        if (!parentInternalId) {
          // The target column is NOT NULL, so without the parent there is no
          // valid row to write. Counted as skipped; the next run resolves it.
          counts.skipped++;
          continue;
        }
        values[mapped.parentColumn ?? 'parentId'] = parentInternalId;
      }

      const checksum = await recordChecksum(entity.data, args.volatileFields);
      const outcome = await upsertByMapping({
        db: args.db,
        connectionId: args.connectionId,
        externalEntityType: args.entityDef.externalEntityType,
        externalEntityId: externalId,
        internalEntityType: target.eventEntityType,
        table: target.table,
        idPrefix: target.idPrefix,
        dedupColumn: target.dedupColumn,
        values,
        checksum,
      });

      if (outcome.action === 'created') counts.created++;
      else if (outcome.action === 'updated') counts.modified++;
      else counts.skipped++;

      if (outcome.action !== 'skipped') {
        // Outside the failure accounting on purpose. The row and its checksum
        // are already committed, so counting a queue/realtime hiccup as a record
        // failure would mark the run `partial` over data that landed fine — and
        // the checksum guarantees the retry skips the record, so the "failure"
        // could never be repaired anyway.
        await publishEntityEventRaw({
          env: args.env as never,
          db: args.db as never,
          workspaceId: args.workspaceId,
          userId: args.ownerId,
          entityType: target.eventEntityType as never,
          action: outcome.action === 'created' ? 'created' : 'updated',
          entityId: outcome.internalId,
          data: { id: outcome.internalId, ...values },
        }).catch((err: unknown) => {
          console.error(
            `[connectors/ingest] entity event for ${outcome.internalId} failed to publish:`,
            err,
          );
        });
      }
    } catch (err) {
      counts.failed++;
      if (errorSamples.length < MAX_ERROR_SAMPLES) {
        errorSamples.push({ externalId, message: sanitiseErrorMessage(err) });
      }
      console.error(`[connectors/ingest] record ${externalId} failed: ${sanitiseErrorMessage(err)}`);
    }
  }

  return { ...counts, errorSamples };
}
