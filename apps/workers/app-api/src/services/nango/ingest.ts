/**
 * Nango sync ingest — the single write path from a Nango model into WeldSuite.
 *
 * One page of records at a time, so a Worker invocation never holds an
 * unbounded set in memory. Each record follows the same three steps as the
 * legacy CRM sync engine (`integration-webhook-worker/lib/engine/sync/upsert`):
 *
 *   1. Existing `integration_entity_mappings` row?  checksum match → skip,
 *      otherwise update the internal row.
 *   2. No mapping → dedup on a natural key (email) → link + update.
 *   3. No match → create + record the mapping.
 *
 * Reusing `integration_entity_mappings` keeps one mapping table for both the
 * legacy adapters and Nango, so an entity synced by either is deduped against
 * the same rows.
 *
 * Tenant isolation: `db` is already the tenant database resolved from the
 * connection's workspace. Nothing here takes a workspace id — there is no code
 * path that could address another tenant's rows.
 *
 * Each entity write and its mapping write commit together — see `atomically`.
 * neon-http has no interactive transactions, so this goes through `db.batch()`,
 * which Neon runs as one transaction per HTTP request.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { ConnectorDef, ConnectorSyncDef } from '@weldsuite/nango';
import { getConnector } from '@weldsuite/nango';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { externalIdOf, isDeletedRecord, mapNangoRecord, type MappedRecord } from './mappers';

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
  /** Local `nango_connections.id` — the mapping-table key. */
  connectionId: string;
  connector: ConnectorDef;
  sync: ConnectorSyncDef;
  records: Array<Record<string, unknown>>;
  /** Clerk user id recorded as the owner of newly imported rows. */
  ownerId: string;
  /** Passed through to entity events so downstream sinks see the tenant. */
  workspaceId: string;
  env: Record<string, unknown>;
}

/** Only the first few failures are stored — enough to see the shape of a bad import. */
const MAX_ERROR_SAMPLES = 5;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * Providers do not guarantee key order, so a plain `JSON.stringify` would
 * produce a different checksum for a byte-identical record and turn every
 * re-delivery into a pointless update.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * SHA-256 of the record for change detection.
 *
 * Nango's `_nango_metadata` envelope is excluded: its cursor and
 * `last_modified_at` change on every delivery, so including it would defeat
 * the skip-if-unchanged path entirely.
 */
export async function recordChecksum(record: Record<string, unknown>): Promise<string> {
  const { _nango_metadata: _ignored, ...payload } = record;
  const encoded = new TextEncoder().encode(stableStringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function emptyCounts(): IngestCounts {
  return { created: 0, modified: 0, skipped: 0, deleted: 0, failed: 0 };
}

/** Longest error text we keep per record. */
const MAX_ERROR_MESSAGE_LENGTH = 200;

/**
 * Strip customer data out of a driver error before it is logged or persisted.
 *
 * Postgres embeds the offending value in its messages — `Key (email)=(jelle@
 * acme.example) already exists` — and these strings land in `nango_sync_runs`
 * and are rendered in the WeldConnect UI. The column name is the diagnostic
 * worth keeping; the value is the tenant's contact data.
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

/** Table + id prefix + dedup column for each mapped entity. */
function targetFor(entity: MappedRecord['entity']): {
  table: PgTable;
  idPrefix: string;
  dedupColumn: string | null;
  entityType: 'company' | 'person' | 'opportunity';
} {
  switch (entity) {
    case 'company':
      return { table: schema.companies, idPrefix: 'comp', dedupColumn: 'email', entityType: 'company' };
    case 'person':
      return { table: schema.people, idPrefix: 'pers', dedupColumn: 'email', entityType: 'person' };
    case 'opportunity':
      // Opportunity names are not unique — dedup only via the mapping table.
      return { table: schema.crmOpportunities, idPrefix: 'opp', dedupColumn: null, entityType: 'opportunity' };
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

/** The connector's company sync — used to resolve an account reference. */
function companySyncOf(connector: ConnectorDef): ConnectorSyncDef | undefined {
  return connector.syncs.find((s) => s.internalEntity === 'company');
}

/**
 * Commit related writes as one unit.
 *
 * An entity row and its `integration_entity_mappings` row must land together.
 * Split across two statements, a Worker dying in between leaves a row with no
 * mapping — and the next delivery re-creates it, which for opportunities (no
 * natural dedup key) is an unbounded duplicate per retry.
 *
 * The tenant DB is neon-http, which has no interactive transactions
 * (`db.transaction()` throws "No transactions support"). It does have
 * `db.batch()`, which Neon executes as a single transaction in one HTTP
 * request — the guarantee we need. Drivers with it the other way round (pglite,
 * which the tests use) fall back to a real transaction, so both paths are
 * atomic and the tests exercise the production semantics rather than a
 * weaker stand-in.
 *
 * `build` is called with the handle to construct against. Drizzle query
 * builders are lazy, so building does not execute.
 */
async function atomically(
  db: Database,
  build: (handle: Database) => unknown[],
): Promise<void> {
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
  const cols = args.table as unknown as Record<string, any>;

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
    // Oldest row wins. `email` is not unique on `companies` (shared info@
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
  // mapping is re-created on every redelivery, and opportunities have no
  // natural key to dedup the duplicates against.
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
 * Record a person's employment at a company, if it isn't recorded already.
 *
 * The junction is time-bounded, so re-syncing must not open a second stint —
 * an existing open row for the same pair is left untouched.
 */
async function linkPersonToCompany(db: Database, personId: string, companyId: string): Promise<void> {
  const [existing] = await db
    .select({ id: schema.personCompanies.id })
    .from(schema.personCompanies)
    .where(
      and(
        eq(schema.personCompanies.personId, personId),
        eq(schema.personCompanies.companyId, companyId),
        isNull(schema.personCompanies.endedAt),
      ),
    )
    .limit(1);
  if (existing) return;

  await db.insert(schema.personCompanies).values({
    id: generateId('pc'),
    personId,
    companyId,
    isPrimary: true,
  });
}

/**
 * Soft-delete the internal row behind a deleted external record.
 *
 * The mapping row is kept: if the record comes back (a provider "undelete", or
 * a filter change that re-includes it) it re-links to the same internal row
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
  const cols = table as unknown as Record<string, any>;
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
 * Ingest one page of Nango records into the tenant database.
 *
 * A record that fails is counted and skipped — one malformed row from a
 * provider must not abort the other 999 in the page.
 */
export async function ingestRecords(args: IngestArgs): Promise<IngestResult> {
  const counts = emptyCounts();
  const errorSamples: IngestResult['errorSamples'] = [];
  const target = targetFor(args.sync.internalEntity);
  const companySync = companySyncOf(args.connector);

  for (const record of args.records) {
    const externalId = externalIdOf(record);
    if (!externalId) {
      counts.skipped++;
      continue;
    }

    try {
      if (isDeletedRecord(record)) {
        const mapping = await findMapping(
          args.db,
          args.connectionId,
          args.sync.externalEntityType,
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
            entityType: target.entityType,
            action: 'deleted',
            entityId: internalId,
            data: { id: internalId },
          });
        } else {
          counts.skipped++;
        }
        continue;
      }

      const mapped = mapNangoRecord(args.sync.internalEntity, record);
      if (!mapped) {
        counts.skipped++;
        continue;
      }

      const values: Record<string, unknown> = { ...mapped.values };
      let accountInternalId: string | null = null;

      if (mapped.entity === 'person' || mapped.entity === 'opportunity') {
        // Resolve the owning account through the company mapping written by the
        // company sync. Order is not guaranteed across syncs, so an unresolved
        // account is normal on a first run — the next run links it.
        accountInternalId =
          mapped.accountExternalId && companySync
            ? ((
                await findMapping(
                  args.db,
                  args.connectionId,
                  companySync.externalEntityType,
                  mapped.accountExternalId,
                )
              )?.internalEntityId ?? null)
            : null;

        if (mapped.entity === 'opportunity') {
          if (!accountInternalId) {
            // crm_opportunities.customer_id is NOT NULL — without a customer
            // there is no valid row to write.
            counts.skipped++;
            continue;
          }
          values.customerId = accountInternalId;
          values.ownerId = args.ownerId;
        }
      }

      const checksum = await recordChecksum(record);
      const outcome = await upsertByMapping({
        db: args.db,
        connectionId: args.connectionId,
        externalEntityType: args.sync.externalEntityType,
        externalEntityId: externalId,
        internalEntityType: target.entityType,
        table: target.table,
        idPrefix: target.idPrefix,
        dedupColumn: target.dedupColumn,
        values,
        checksum,
      });

      if (outcome.action === 'created') counts.created++;
      else if (outcome.action === 'updated') counts.modified++;
      else counts.skipped++;

      // A person's employer lives in the `person_companies` junction, not on
      // the person row — link it once the company mapping resolves.
      if (mapped.entity === 'person' && accountInternalId) {
        await linkPersonToCompany(args.db, outcome.internalId, accountInternalId);
      }

      if (outcome.action !== 'skipped') {
        // Outside the failure accounting on purpose. The row and its checksum
        // are already committed, so counting a queue/realtime hiccup as a
        // record failure would mark the run `partial` over data that landed
        // fine — and the checksum guarantees the retry skips the record, so the
        // "failure" could never be repaired anyway.
        await publishEntityEventRaw({
          env: args.env as never,
          db: args.db as never,
          workspaceId: args.workspaceId,
          userId: args.ownerId,
          entityType: target.entityType,
          action: outcome.action === 'created' ? 'created' : 'updated',
          entityId: outcome.internalId,
          data: { id: outcome.internalId, ...values },
        }).catch((err: unknown) => {
          console.error(`[nango/ingest] entity event for ${outcome.internalId} failed to publish:`, err);
        });
      }
    } catch (err) {
      counts.failed++;
      if (errorSamples.length < MAX_ERROR_SAMPLES) {
        errorSamples.push({ externalId, message: sanitiseErrorMessage(err) });
      }
      console.error(`[nango/ingest] record ${externalId} failed: ${sanitiseErrorMessage(err)}`);
    }
  }

  return { ...counts, errorSamples };
}

/** Resolve the connector + sync a webhook's `(integration, model)` pair refers to. */
export function resolveSync(
  providerConfigKey: string,
  model: string,
): { connector: ConnectorDef; sync: ConnectorSyncDef } | null {
  const connector = getConnector(providerConfigKey);
  if (!connector) return null;
  const sync = connector.syncs.find((s) => s.model === model);
  if (!sync) return null;
  return { connector, sync };
}
