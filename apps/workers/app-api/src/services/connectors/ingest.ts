/**
 * Connector sync ingest — the write path from a provider model into WeldSuite.
 *
 * One page of records at a time. Each record follows the same three steps as
 * the CRM sync engine:
 *
 *   1. Existing `integration_entity_mappings` row? checksum match → skip,
 *      otherwise update the internal row.
 *   2. No mapping → dedup on a natural key (email / slug) → link + update.
 *   3. No match → create + record the mapping.
 *
 * Tenant isolation: `db` is already the tenant database. Nothing here takes a
 * workspace id from the client.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { ConnectorSyncDef } from '@weldsuite/connectors';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import {
  externalIdOf,
  isDeletedRecord,
  mapConnectorRecord,
  type MappedOrder,
  type MappedRecord,
} from './mappers';

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
  connectionId: string;
  provider: string;
  displayName?: string | null;
  storeUrl?: string | null;
  sync: ConnectorSyncDef;
  records: Array<Record<string, unknown>>;
  ownerId: string;
  workspaceId: string;
  env: Record<string, unknown>;
  /** Webhook delete topics send a stub payload without status=trash. */
  forceDeleted?: boolean;
}

const MAX_ERROR_SAMPLES = 5;
const MAX_ERROR_MESSAGE_LENGTH = 200;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export async function recordChecksum(record: Record<string, unknown>): Promise<string> {
  const encoded = new TextEncoder().encode(stableStringify(record));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function emptyCounts(): IngestCounts {
  return { created: 0, modified: 0, skipped: 0, deleted: 0, failed: 0 };
}

export function sanitiseErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/\(([^)]*)\)=\([^)]*\)/g, '($1)=(redacted)')
    .replace(/'[^']*'/g, "'redacted'")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function targetFor(entity: MappedRecord['entity']): {
  table: PgTable;
  idPrefix: string;
  dedupColumn: string | null;
  entityType: 'product' | 'order' | 'person';
} {
  switch (entity) {
    case 'product':
      return { table: schema.products, idPrefix: 'prd', dedupColumn: 'sku', entityType: 'product' };
    case 'order':
      return { table: schema.orders, idPrefix: 'ord', dedupColumn: 'externalOrderId', entityType: 'order' };
    case 'person':
      return { table: schema.people, idPrefix: 'pers', dedupColumn: 'email', entityType: 'person' };
  }
}

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
  for (const statement of build(db)) await (statement as Promise<unknown>);
}

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
    await atomically(db, (h) => [
      h
        .update(args.table)
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

async function softDeleteMapped(db: Database, table: PgTable, internalId: string, mappingId: string): Promise<void> {
  const cols = table as unknown as Record<string, any>;
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

async function replaceOrderItems(
  db: Database,
  connectionId: string,
  provider: string,
  orderId: string,
  mapped: MappedOrder,
): Promise<void> {
  await db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, orderId));
  if (mapped.lineItems.length === 0) return;

  for (const item of mapped.lineItems) {
    let productId: string | null = null;
    if (item.externalProductId) {
      const mapping = await findMapping(db, connectionId, `${provider}_product`, item.externalProductId);
      productId = mapping?.internalEntityId ?? null;
    }
    await db.insert(schema.orderItems).values({
      id: generateId('oitm'),
      orderId,
      productId,
      sku: item.sku,
      name: item.name,
      imageUrl: item.imageUrl,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
    });
  }
}

async function upsertSalesChannel(args: {
  db: Database;
  productId: string;
  connectionId: string;
  provider: string;
  displayName: string | null | undefined;
  externalId: string;
  externalUrl: string | null;
}): Promise<void> {
  const now = new Date();
  const [existing] = await args.db
    .select({ id: schema.productSalesChannels.id })
    .from(schema.productSalesChannels)
    .where(
      and(
        eq(schema.productSalesChannels.connectionId, args.connectionId),
        eq(schema.productSalesChannels.externalId, args.externalId),
      ),
    )
    .limit(1);

  if (existing) {
    await args.db
      .update(schema.productSalesChannels)
      .set({
        productId: args.productId,
        displayName: args.displayName ?? null,
        externalUrl: args.externalUrl,
        status: 'active',
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.productSalesChannels.id, existing.id));
    return;
  }

  await args.db.insert(schema.productSalesChannels).values({
    id: generateId('psch'),
    productId: args.productId,
    connectionId: args.connectionId,
    provider: args.provider,
    displayName: args.displayName ?? null,
    externalId: args.externalId,
    externalUrl: args.externalUrl,
    status: 'active',
    lastSyncedAt: now,
  });
}

async function markSalesChannelDeleted(db: Database, connectionId: string, externalId: string): Promise<void> {
  await db
    .update(schema.productSalesChannels)
    .set({ status: 'deleted_remote', updatedAt: new Date(), lastSyncedAt: new Date() })
    .where(
      and(
        eq(schema.productSalesChannels.connectionId, connectionId),
        eq(schema.productSalesChannels.externalId, externalId),
      ),
    );
}

async function activeSalesChannelCount(db: Database, productId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.productSalesChannels.id })
    .from(schema.productSalesChannels)
    .where(
      and(eq(schema.productSalesChannels.productId, productId), eq(schema.productSalesChannels.status, 'active')),
    );
  return rows.length;
}

export async function ingestRecords(args: IngestArgs): Promise<IngestResult> {
  const counts = emptyCounts();
  const errorSamples: IngestResult['errorSamples'] = [];
  const target = targetFor(args.sync.internalEntity);
  const customerType = `${args.provider}_customer`;

  for (const record of args.records) {
    const externalId = externalIdOf(record);
    if (!externalId) {
      counts.skipped++;
      continue;
    }

    try {
      if (isDeletedRecord(record, args.forceDeleted)) {
        const mapping = await findMapping(args.db, args.connectionId, args.sync.externalEntityType, externalId);
        if (mapping) {
          if (args.sync.internalEntity === 'product') {
            await markSalesChannelDeleted(args.db, args.connectionId, externalId);
            const remaining = await activeSalesChannelCount(args.db, mapping.internalEntityId);
            if (remaining === 0) {
              await softDeleteMapped(args.db, target.table, mapping.internalEntityId, mapping.id);
            }
          } else {
            await softDeleteMapped(args.db, target.table, mapping.internalEntityId, mapping.id);
          }
          counts.deleted++;
          await publishEntityEventRaw({
            env: args.env as never,
            db: args.db as never,
            workspaceId: args.workspaceId,
            userId: args.ownerId,
            entityType: target.entityType,
            action: 'deleted',
            entityId: mapping.internalEntityId,
            data: { id: mapping.internalEntityId },
          });
        } else {
          counts.skipped++;
        }
        continue;
      }

      const mapped = mapConnectorRecord(args.sync.internalEntity, record, args.provider);
      if (!mapped) {
        counts.skipped++;
        continue;
      }

      const values: Record<string, unknown> = { ...mapped.values };
      if (mapped.entity === 'person') {
        values.ownerId = args.ownerId;
      }
      if (mapped.entity === 'product' || mapped.entity === 'order') {
        values.createdBy = values.createdBy ?? args.ownerId;
      }
      if (mapped.entity === 'order' && mapped.customerExternalId) {
        const customer = await findMapping(args.db, args.connectionId, customerType, mapped.customerExternalId);
        if (customer) values.personId = customer.internalEntityId;
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

      if (mapped.entity === 'order' && outcome.action !== 'skipped') {
        await replaceOrderItems(args.db, args.connectionId, args.provider, outcome.internalId, mapped);
      }

      if (mapped.entity === 'product') {
        const permalink =
          mapped.externalUrl
          ?? (args.storeUrl && args.provider === 'shopify'
            ? `${args.storeUrl}/products/${String(mapped.values.slug ?? '')}`
            : args.storeUrl
              ? `${args.storeUrl}/?p=${externalId}`
              : null);
        await upsertSalesChannel({
          db: args.db,
          productId: outcome.internalId,
          connectionId: args.connectionId,
          provider: args.provider,
          displayName: args.displayName,
          externalId,
          externalUrl: permalink,
        });
      }

      if (outcome.action === 'created') counts.created++;
      else if (outcome.action === 'updated') counts.modified++;
      else counts.skipped++;

      if (outcome.action !== 'skipped') {
        await publishEntityEventRaw({
          env: args.env as never,
          db: args.db as never,
          workspaceId: args.workspaceId,
          userId: args.ownerId,
          entityType: target.entityType,
          action: outcome.action === 'created' ? 'created' : 'updated',
          entityId: outcome.internalId,
          data: { id: outcome.internalId },
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
