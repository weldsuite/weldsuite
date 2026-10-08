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
import { expandPicqerProductStock, getConnector, type ConnectorSyncDef } from '@weldsuite/connectors';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { promoteAccountingRole } from '@weldsuite/books-domain/accounting-roles';
import {
  externalIdOf,
  isDeletedRecord,
  mapConnectorRecord,
  type MappedBankAccount,
  type MappedBankTransaction,
  type MappedBill,
  type MappedInvoice,
  type MappedOrder,
  type MappedParty,
  type MappedProduct,
  type MappedProductVariant,
  type MappedRecord,
  type MappedWmsEntity,
} from './mappers';
import {
  applyInboundFieldMappings,
  type ConnectorFieldMappingRow,
} from './field-mapper';
import {
  syncMoneybirdDocumentAttachments,
  type MoneybirdAttachmentSyncContext,
} from './moneybird-attachments';
import { asText } from '@weldsuite/text';

type IngestEntity = 'product' | 'order' | 'person';

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
  /** WeldBooks accounting entity for invoice/bill/bank rows. */
  entityId?: string | null;
  /** Webhook delete topics send a stub payload without status=trash. */
  forceDeleted?: boolean;
  /**
   * Moneybird PDF / attachment download context. When set, invoice and bill
   * ingest stores files in R2 and writes `attachmentKeys`.
   */
  moneybirdAttachments?: MoneybirdAttachmentSyncContext | null;
}

const MAX_ERROR_SAMPLES = 5;
const MAX_ERROR_MESSAGE_LENGTH = 200;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    })
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

function loadConnectorFieldMappings(
  db: Database,
  connectionId: string,
  entityType: string,
): Promise<ConnectorFieldMappingRow[]> {
  const fm = schema.integrationFieldMappings;
  return Promise.resolve(
    db
      .select({
        externalFieldPath: fm.externalFieldPath,
        internalFieldPath: fm.internalFieldPath,
        direction: fm.direction,
        transformType: fm.transformType,
        transformConfig: fm.transformConfig,
        isRequired: fm.isRequired,
      })
      .from(fm)
      .where(and(eq(fm.connectionId, connectionId), eq(fm.entityType, entityType)))
  );
}

function applyMappingsToRecord(
  record: Record<string, unknown>,
  mapped: MappedRecord,
  mappings: ConnectorFieldMappingRow[],
): MappedRecord {
  if (mappings.length === 0) return mapped;
  if (!('values' in mapped) || !mapped.values) return mapped;
  return {
    ...mapped,
    values: applyInboundFieldMappings(record, mapped.values, mappings),
  } as MappedRecord;
}

export function sanitiseErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : asText(err);
  return raw
    // Postgres key details, e.g. `Key (lower(email))=(a@b.com)`: keep the key, drop the value.
    .replace(/\)=\([^)]*\)/g, ')=(redacted)')
    .replace(/'[^']*'/g, "'redacted'")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function targetFor(entity: IngestEntity): {
  table: PgTable;
  idPrefix: string;
  dedupColumn: string | null;
  entityType: IngestEntity;
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

type VariantIndex = { id: string; sku: string | null; attributes: unknown };

function indexExistingVariants(existingRows: VariantIndex[]): {
  bySku: Map<string, VariantIndex>;
  byExternal: Map<string, VariantIndex>;
} {
  const bySku = new Map<string, VariantIndex>();
  const byExternal = new Map<string, VariantIndex>();
  for (const row of existingRows) {
    if (row.sku) bySku.set(row.sku, row);
    const externalId = (row.attributes as { externalId?: string } | null)?.externalId;
    if (externalId) byExternal.set(externalId, row);
  }
  return { bySku, byExternal };
}

function buildVariantFields(variant: MappedProductVariant) {
  const optionValues = variant.optionValues
    ? Object.entries(variant.optionValues).map(([name, value]) => ({ name, value }))
    : null;
  return {
    name: variant.name?.trim() || optionValues?.map((o) => o.value).join(' / ') || 'Variant',
    sku: variant.sku,
    price: variant.price,
    inventoryQuantity: variant.inventoryQuantity ?? 0,
    trackInventory: variant.trackInventory,
    optionValues,
    status: variant.status || 'active',
    position: variant.position,
    attributes: { externalId: variant.externalId },
    updatedAt: new Date(),
  };
}

async function upsertProductVariant(
  db: Database,
  productId: string,
  variant: MappedProductVariant,
  index: { bySku: Map<string, VariantIndex>; byExternal: Map<string, VariantIndex> },
): Promise<void> {
  const { bySku, byExternal } = index;
  const match = (variant.sku ? bySku.get(variant.sku) : undefined) ?? byExternal.get(variant.externalId);
  const fields = buildVariantFields(variant);

  if (match) {
    await db
      .update(schema.productVariants)
      .set(fields)
      .where(eq(schema.productVariants.id, match.id));
    if (variant.sku) bySku.set(variant.sku, match);
    byExternal.set(variant.externalId, match);
    return;
  }

  const id = generateId('pvr');
  await db.insert(schema.productVariants).values({
    id,
    productId,
    ...fields,
  });
  const created: VariantIndex = { id, sku: variant.sku, attributes: fields.attributes };
  if (variant.sku) bySku.set(variant.sku, created);
  byExternal.set(variant.externalId, created);
}

async function upsertProductVariants(
  db: Database,
  productId: string,
  variants: MappedProductVariant[],
): Promise<void> {
  const existingRows = await db
    .select()
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.productId, productId), isNull(schema.productVariants.deletedAt)));

  const index = indexExistingVariants(existingRows);
  for (const variant of variants) {
    await upsertProductVariant(db, productId, variant, index);
  }

  await db
    .update(schema.products)
    .set({
      hasVariants: true,
      variantCount: variants.length,
      updatedAt: new Date(),
    })
    .where(eq(schema.products.id, productId));
}

async function upsertSalesChannel(args: {
  db: Database;
  productId: string;
  connectionId: string;
  provider: string;
  displayName: string | null | undefined;
  externalId: string;
  externalUrl: string | null;
  price?: string | null;
  listingStatus?: string | null;
}): Promise<void> {
  const now = new Date();
  const listingStatus =
    args.listingStatus === 'active' || args.listingStatus === 'inactive' || args.listingStatus === 'draft'
      ? args.listingStatus
      : 'active';
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
        price: args.price ?? undefined,
        listingStatus,
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
    price: args.price ?? null,
    listingStatus,
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

async function loadDefaultEntityId(db: Database): Promise<string | null> {
  const [settings] = await db.select({ defaultEntityId: schema.settings.defaultEntityId }).from(schema.settings).limit(1);
  return settings?.defaultEntityId ?? null;
}

async function resolveIngestEntityId(args: IngestArgs): Promise<string | null> {
  if (args.entityId) return args.entityId;
  return loadDefaultEntityId(args.db);
}

function partySyncExternalType(provider: string): string {
  return getConnector(provider)?.syncs.find((sync) => sync.internalEntity === 'party')?.externalEntityType
    ?? `${provider}_contact`;
}

async function findIdentityByEmail(
  db: Database,
  table: typeof schema.companies | typeof schema.people,
  email: string,
): Promise<string | null> {
  const cols = table as unknown as Record<string, any>;
  const [row] = await db
    .select({ id: cols.id })
    .from(table)
    .where(and(eq(cols.email, email), isNull(cols.deletedAt)))
    .orderBy(asc(cols.createdAt), asc(cols.id))
    .limit(1);
  return row?.id ?? null;
}

async function findCompanyByVat(db: Database, vatNumber: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.vatNumber, vatNumber), isNull(schema.companies.deletedAt)))
    .orderBy(asc(schema.companies.createdAt), asc(schema.companies.id))
    .limit(1);
  return row?.id ?? null;
}

async function wrappingPartyId(db: Database, kind: 'company' | 'person', identityId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.parties.id })
    .from(schema.parties)
    .where(
      and(
        kind === 'company' ? eq(schema.parties.companyId, identityId) : eq(schema.parties.personId, identityId),
        isNull(schema.parties.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

type PartyUpsertArgs = {
  db: Database;
  connectionId: string;
  provider: string;
  ownerId: string;
  mapped: MappedParty;
  checksum: string;
};

type IdentityTable = typeof schema.companies | typeof schema.people;

async function partyMappingChecksumMatches(db: Database, mappingId: string, checksum: string): Promise<boolean> {
  const [row] = await db
    .select({ syncChecksum: schema.integrationEntityMappings.syncChecksum })
    .from(schema.integrationEntityMappings)
    .where(eq(schema.integrationEntityMappings.id, mappingId))
    .limit(1);
  return row?.syncChecksum === checksum;
}

async function updateMappedParty(
  args: PartyUpsertArgs,
  mapping: { id: string; internalEntityId: string },
  identityTable: IdentityTable,
  identityValues: Record<string, unknown>,
): Promise<void> {
  const [party] = await args.db
    .select({ companyId: schema.parties.companyId, personId: schema.parties.personId })
    .from(schema.parties)
    .where(eq(schema.parties.id, mapping.internalEntityId))
    .limit(1);
  const identityId = args.mapped.kind === 'company' ? party?.companyId : party?.personId;
  await atomically(args.db, (h) => {
    const statements: unknown[] = [
      h
        .update(schema.parties)
        .set({ ...args.mapped.values, deletedAt: null, updatedAt: new Date() } as never)
        .where(eq(schema.parties.id, mapping.internalEntityId)),
      h
        .update(schema.integrationEntityMappings)
        .set({ syncChecksum: args.checksum, lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.integrationEntityMappings.id, mapping.id)),
    ];
    if (identityId) {
      statements.unshift(
        h
          .update(identityTable)
          .set({ ...identityValues, deletedAt: null } as never)
          .where(eq(identityTable.id, identityId)),
      );
    }
    return statements;
  });
}

/** Find the company/person identity row (email, then VAT) or create it; existing rows are refreshed. */
async function resolvePartyIdentity(
  args: PartyUpsertArgs,
  identityTable: IdentityTable,
  identityValues: Record<string, unknown>,
): Promise<string> {
  const email = typeof args.mapped.identity.email === 'string' ? args.mapped.identity.email : null;
  const vatNumber = typeof args.mapped.identity.vatNumber === 'string' ? args.mapped.identity.vatNumber : null;
  const existingId =
    (email ? await findIdentityByEmail(args.db, identityTable, email) : null)
    ?? (args.mapped.kind === 'company' && vatNumber ? await findCompanyByVat(args.db, vatNumber) : null);

  if (existingId) {
    await args.db
      .update(identityTable)
      .set({ ...identityValues, deletedAt: null } as never)
      .where(eq(identityTable.id, existingId));
    return existingId;
  }

  const identityId = generateId(args.mapped.kind === 'company' ? 'company' : 'person');
  const displayName = asText(args.mapped.identity.displayName ?? args.mapped.values.displayName ?? 'Contact');
  await args.db.insert(identityTable).values({
    id: identityId,
    displayName,
    ...identityValues,
  } as never);
  return identityId;
}

/** Find the party wrapping an identity or create it; existing rows are refreshed. */
async function resolveWrappingParty(
  args: PartyUpsertArgs,
  identityId: string,
): Promise<{ partyId: string; created: boolean }> {
  const existingId = await wrappingPartyId(args.db, args.mapped.kind, identityId);
  if (existingId) {
    await args.db
      .update(schema.parties)
      .set({ ...args.mapped.values, deletedAt: null, updatedAt: new Date() } as never)
      .where(eq(schema.parties.id, existingId));
    return { partyId: existingId, created: false };
  }

  const partyId = generateId('party');
  await args.db.insert(schema.parties).values({
    id: partyId,
    kind: args.mapped.kind,
    companyId: args.mapped.kind === 'company' ? identityId : null,
    personId: args.mapped.kind === 'person' ? identityId : null,
    ownerId: args.ownerId,
    ...args.mapped.values,
  } as never);
  return { partyId, created: true };
}

async function upsertParty(args: PartyUpsertArgs): Promise<UpsertOutcome> {
  const externalType = partySyncExternalType(args.provider);
  const mapping = await findMapping(args.db, args.connectionId, externalType, args.mapped.externalId);
  const identityTable = args.mapped.kind === 'company' ? schema.companies : schema.people;
  const identityValues = {
    ...args.mapped.identity,
    ownerId: args.ownerId,
    updatedAt: new Date(),
  };

  if (mapping) {
    if (await partyMappingChecksumMatches(args.db, mapping.id, args.checksum)) {
      return { action: 'skipped', internalId: mapping.internalEntityId };
    }
    await updateMappedParty(args, mapping, identityTable, identityValues);
    return { action: 'updated', internalId: mapping.internalEntityId };
  }

  const identityId = await resolvePartyIdentity(args, identityTable, identityValues);
  const { partyId, created } = await resolveWrappingParty(args, identityId);

  await args.db.insert(schema.integrationEntityMappings).values({
    id: generateId('iem'),
    connectionId: args.connectionId,
    externalEntityType: externalType,
    externalEntityId: args.mapped.externalId,
    internalEntityType: 'party',
    internalEntityId: partyId,
    lastSyncedAt: new Date(),
    syncChecksum: args.checksum,
  });

  return { action: created ? 'created' : 'updated', internalId: partyId };
}

async function softDeleteParty(db: Database, partyId: string, mappingId: string): Promise<void> {
  const [party] = await db
    .select({ companyId: schema.parties.companyId, personId: schema.parties.personId })
    .from(schema.parties)
    .where(eq(schema.parties.id, partyId))
    .limit(1);
  const now = new Date();
  await atomically(db, (h) => {
    const statements: unknown[] = [
      h.update(schema.parties).set({ deletedAt: now, updatedAt: now }).where(eq(schema.parties.id, partyId)),
      h
        .update(schema.integrationEntityMappings)
        .set({ syncChecksum: null, lastSyncedAt: now, updatedAt: now })
        .where(eq(schema.integrationEntityMappings.id, mappingId)),
    ];
    if (party?.companyId) {
      statements.push(
        h.update(schema.companies).set({ deletedAt: now, updatedAt: now }).where(eq(schema.companies.id, party.companyId)),
      );
    }
    if (party?.personId) {
      statements.push(
        h.update(schema.people).set({ deletedAt: now, updatedAt: now }).where(eq(schema.people.id, party.personId)),
      );
    }
    return statements;
  });
}

async function ingestNestedContact(args: {
  db: Database;
  connectionId: string;
  provider: string;
  ownerId: string;
  contact: Record<string, unknown>;
}): Promise<string | null> {
  const mapped = mapConnectorRecord('party', args.contact, args.provider);
  if (mapped?.entity !== 'party') return null;
  const checksum = await recordChecksum(args.contact);
  const outcome = await upsertParty({
    db: args.db,
    connectionId: args.connectionId,
    provider: args.provider,
    ownerId: args.ownerId,
    mapped,
    checksum,
  });
  return outcome.internalId;
}

async function resolveContactId(args: {
  db: Database;
  connectionId: string;
  provider: string;
  ownerId: string;
  contactExternalId: string | null;
  nestedContact: Record<string, unknown> | null;
}): Promise<string | null> {
  const externalType = partySyncExternalType(args.provider);
  if (args.contactExternalId) {
    const mapped = await findMapping(args.db, args.connectionId, externalType, args.contactExternalId);
    if (mapped) return mapped.internalEntityId;
  }
  if (args.nestedContact) {
    return ingestNestedContact({
      db: args.db,
      connectionId: args.connectionId,
      provider: args.provider,
      ownerId: args.ownerId,
      contact: args.nestedContact,
    });
  }
  return null;
}

async function replaceDocumentItems(args: {
  db: Database;
  connectionId: string;
  provider: string;
  entityId: string;
  parentId: string;
  kind: 'invoice' | 'bill';
  items: Array<{
    externalProductId: string | null;
    description: string;
    quantity: string;
    unitPrice: string;
    taxRate: string | null;
    taxAmount: string | null;
    lineTotal: string | null;
    lineTotalWithTax: string | null;
    sortOrder: number;
  }>;
}): Promise<void> {
  if (args.kind === 'invoice') {
    await args.db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, args.parentId));
  } else {
    await args.db.delete(schema.billItems).where(eq(schema.billItems.billId, args.parentId));
  }
  const productType = getConnector(args.provider)?.syncs.find((sync) => sync.internalEntity === 'product')?.externalEntityType
    ?? `${args.provider}_product`;
  for (const item of args.items) {
    let productId: string | null = null;
    if (item.externalProductId) {
      productId = (await findMapping(args.db, args.connectionId, productType, item.externalProductId))?.internalEntityId ?? null;
    }
    if (args.kind === 'invoice') {
      await args.db.insert(schema.invoiceItems).values({
        id: generateId('ili'),
        entityId: args.entityId,
        invoiceId: args.parentId,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate,
        taxAmount: item.taxAmount,
        lineTotal: item.lineTotal,
        lineTotalWithTax: item.lineTotalWithTax,
        productId,
        sortOrder: item.sortOrder,
      });
    } else {
      await args.db.insert(schema.billItems).values({
        id: generateId('bli'),
        entityId: args.entityId,
        billId: args.parentId,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate,
        taxAmount: item.taxAmount,
        lineTotal: item.lineTotal,
        lineTotalWithTax: item.lineTotalWithTax,
        productId,
        sortOrder: item.sortOrder,
      });
    }
  }
}

async function maybeSyncMoneybirdAttachments(args: {
  args: IngestArgs;
  internalId: string;
  entity: 'invoice' | 'bill';
  externalId: string;
  record: Record<string, unknown>;
  /** When true, always attempt download. When false, only if attachmentKeys empty. */
  force: boolean;
}): Promise<void> {
  const ctx = args.args.moneybirdAttachments;
  if (!ctx || args.args.provider !== 'moneybird') return;
  if (ctx.budget.remaining <= 0) return;

  const table = args.entity === 'invoice' ? schema.invoices : schema.bills;
  const cols = table as unknown as { id: typeof schema.invoices.id; attachmentKeys: typeof schema.invoices.attachmentKeys };

  if (!args.force) {
    const [row] = await args.args.db
      .select({ attachmentKeys: cols.attachmentKeys })
      .from(table)
      .where(eq(cols.id, args.internalId))
      .limit(1);
    // null/undefined = never attempted (catch-up). [] or [...] = already tried.
    if (row?.attachmentKeys != null) return;
  }

  const keys = await syncMoneybirdDocumentAttachments({
    ctx,
    externalEntityType: args.args.sync.externalEntityType,
    externalId: args.externalId,
    record: args.record,
  });
  // null = budget exhausted with nothing stored — leave keys empty for retry.
  if (keys === null) return;
  // Empty array after soft-fails: still write so we don't hammer drafts forever
  // on every checksum-skip pass. Create/update will retry when the record changes.
  await args.args.db
    .update(table)
    .set({ attachmentKeys: keys, updatedAt: new Date() } as never)
    .where(eq(cols.id, args.internalId));
}

type IngestEventEntityType = Parameters<typeof publishEntityEventRaw>[0]['entityType'];

/** Mutable per-batch state shared by the record handlers. */
interface IngestState {
  counts: IngestCounts;
  errorSamples: IngestResult['errorSamples'];
}

function pushErrorSample(state: IngestState, externalId: string, message: string): void {
  if (state.errorSamples.length < MAX_ERROR_SAMPLES) {
    state.errorSamples.push({ externalId, message });
  }
}

/**
 * Run `handle` for every record with an external id. Records without one are
 * skipped; a throwing handler counts as a failed record and never aborts the batch.
 */
async function runIngestLoop(
  records: Array<Record<string, unknown>>,
  logLabel: string,
  handle: (record: Record<string, unknown>, externalId: string, state: IngestState) => Promise<void>,
): Promise<IngestResult> {
  const state: IngestState = { counts: emptyCounts(), errorSamples: [] };

  for (const record of records) {
    const externalId = externalIdOf(record);
    if (!externalId) {
      state.counts.skipped++;
      continue;
    }

    try {
      await handle(record, externalId, state);
    } catch (err) {
      state.counts.failed++;
      pushErrorSample(state, externalId, sanitiseErrorMessage(err));
      console.error(`[connectors/ingest] ${logLabel} ${externalId} failed: ${sanitiseErrorMessage(err)}`);
    }
  }

  return { ...state.counts, errorSamples: state.errorSamples };
}

function tallyOutcome(counts: IngestCounts, action: UpsertOutcome['action']): void {
  if (action === 'created') counts.created++;
  else if (action === 'updated') counts.modified++;
  else counts.skipped++;
}

async function publishIngestEvent(
  args: IngestArgs,
  entityType: IngestEventEntityType,
  action: 'created' | 'updated' | 'deleted',
  entityId: string,
): Promise<void> {
  await publishEntityEventRaw({
    env: args.env as never,
    db: args.db as never,
    workspaceId: args.workspaceId,
    userId: args.ownerId,
    entityType,
    action,
    entityId,
    data: { id: entityId },
  });
}

/** Publish created/updated for an upsert outcome; skipped rows emit nothing. */
async function publishUpsertEvent(
  args: IngestArgs,
  entityType: IngestEventEntityType,
  outcome: UpsertOutcome,
): Promise<void> {
  if (outcome.action === 'skipped') return;
  await publishIngestEvent(args, entityType, outcome.action === 'created' ? 'created' : 'updated', outcome.internalId);
}

function mapWithFieldMappings(
  args: IngestArgs,
  record: Record<string, unknown>,
  fieldMappings: ConnectorFieldMappingRow[],
): MappedRecord | null {
  const mappedRaw = mapConnectorRecord(args.sync.internalEntity, record, args.provider);
  return mappedRaw ? applyMappingsToRecord(record, mappedRaw, fieldMappings) : null;
}

async function deleteAccountingRecord(args: IngestArgs, externalId: string, counts: IngestCounts): Promise<void> {
  const mapping = await findMapping(args.db, args.connectionId, args.sync.externalEntityType, externalId);
  if (!mapping) {
    counts.skipped++;
    return;
  }

  let entityType: IngestEventEntityType;
  if (args.sync.internalEntity === 'party') {
    const [party] = await args.db
      .select({ kind: schema.parties.kind })
      .from(schema.parties)
      .where(eq(schema.parties.id, mapping.internalEntityId))
      .limit(1);
    await softDeleteParty(args.db, mapping.internalEntityId, mapping.id);
    entityType = party?.kind === 'person' ? 'person' : 'company';
  } else {
    const table = args.sync.internalEntity === 'invoice' ? schema.invoices : schema.bills;
    await softDeleteMapped(args.db, table, mapping.internalEntityId, mapping.id);
    entityType = args.sync.internalEntity === 'invoice' ? 'invoice' : 'bill';
  }
  counts.deleted++;
  await publishIngestEvent(args, entityType, 'deleted', mapping.internalEntityId);
}

async function ingestPartyRecord(
  args: IngestArgs,
  mapped: MappedParty,
  checksum: string,
  counts: IngestCounts,
): Promise<void> {
  const outcome = await upsertParty({
    db: args.db,
    connectionId: args.connectionId,
    provider: args.provider,
    ownerId: args.ownerId,
    mapped,
    checksum,
  });
  tallyOutcome(counts, outcome.action);
  await publishUpsertEvent(args, mapped.kind, outcome);
}

async function ingestDocumentRecord(params: {
  args: IngestArgs;
  entityId: string;
  document: MappedInvoice | MappedBill;
  record: Record<string, unknown>;
  externalId: string;
  checksum: string;
  counts: IngestCounts;
}): Promise<void> {
  const { args, entityId, document, record, externalId, checksum, counts } = params;
  const contactId = await resolveContactId({
    db: args.db,
    connectionId: args.connectionId,
    provider: args.provider,
    ownerId: args.ownerId,
    contactExternalId: document.contactExternalId,
    nestedContact: document.nestedContact,
  });
  if (!contactId) {
    throw new Error('Invoice/bill contact is not mapped — sync contacts first');
  }

  const values: Record<string, unknown> = {
    ...document.values,
    entityId,
    contactId,
    counterpartyId: contactId,
    createdBy: args.ownerId,
    journalEntryId: null,
  };

  const outcome = await upsertByMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: args.sync.externalEntityType,
    externalEntityId: externalId,
    internalEntityType: document.entity,
    table: document.entity === 'invoice' ? schema.invoices : schema.bills,
    idPrefix: document.entity === 'invoice' ? 'inv' : 'bil',
    dedupColumn: null,
    values,
    checksum,
  });

  if (outcome.action !== 'skipped') {
    await replaceDocumentItems({
      db: args.db,
      connectionId: args.connectionId,
      provider: args.provider,
      entityId,
      parentId: outcome.internalId,
      kind: document.entity,
      items: document.lineItems,
    });
    await promoteAccountingRole(
      args.db,
      contactId,
      document.entity === 'invoice' ? 'customer' : 'supplier',
    );
    await publishUpsertEvent(args, document.entity, outcome);
  }

  await maybeSyncMoneybirdAttachments({
    args,
    internalId: outcome.internalId,
    entity: document.entity,
    externalId,
    record,
    force: outcome.action !== 'skipped',
  });

  tallyOutcome(counts, outcome.action);
}

async function ingestAccountingRecords(args: IngestArgs): Promise<IngestResult> {
  const entityId = args.sync.internalEntity === 'party' ? null : await resolveIngestEntityId(args);
  const fieldMappings = await loadConnectorFieldMappings(
    args.db,
    args.connectionId,
    args.sync.internalEntity,
  );

  return runIngestLoop(args.records, 'record', async (record, externalId, { counts }) => {
    if (isDeletedRecord(record, args.forceDeleted)) {
      await deleteAccountingRecord(args, externalId, counts);
      return;
    }

    const mapped = mapWithFieldMappings(args, record, fieldMappings);
    if (!mapped) {
      counts.skipped++;
      return;
    }

    const checksum = await recordChecksum(record);

    if (mapped.entity === 'party') {
      await ingestPartyRecord(args, mapped, checksum, counts);
      return;
    }

    if (!entityId) {
      throw new Error('Select a WeldBooks entity for this Moneybird connection (or set a default entity)');
    }

    await ingestDocumentRecord({
      args,
      entityId,
      document: mapped as MappedInvoice | MappedBill,
      record,
      externalId,
      checksum,
      counts,
    });
  });
}

async function deleteBankRecord(args: IngestArgs, externalId: string, counts: IngestCounts): Promise<void> {
  const mapping = await findMapping(args.db, args.connectionId, args.sync.externalEntityType, externalId);
  if (!mapping) {
    counts.skipped++;
    return;
  }
  const isAccount = args.sync.internalEntity === 'bank_account';
  const table = isAccount ? schema.bankAccounts : schema.bankTransactions;
  await softDeleteMapped(args.db, table, mapping.internalEntityId, mapping.id);
  counts.deleted++;
  await publishIngestEvent(args, isAccount ? 'bank_account' : 'bank_transaction', 'deleted', mapping.internalEntityId);
}

async function ingestBankAccountRecord(params: {
  args: IngestArgs;
  entityId: string;
  account: MappedBankAccount;
  externalId: string;
  checksum: string;
  counts: IngestCounts;
}): Promise<void> {
  const { args, entityId, account, externalId, checksum, counts } = params;
  const outcome = await upsertByMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: args.sync.externalEntityType,
    externalEntityId: externalId,
    internalEntityType: 'bank_account',
    table: schema.bankAccounts,
    idPrefix: 'ba',
    dedupColumn: null,
    values: { ...account.values, entityId },
    checksum,
  });
  tallyOutcome(counts, outcome.action);
  await publishUpsertEvent(args, 'bank_account', outcome);
}

/** Resolve the internal bank account for a transaction, stubbing archived accounts. */
async function resolveBankAccountId(params: {
  args: IngestArgs;
  entityId: string;
  accountExternalType: string;
  txn: MappedBankTransaction;
  financialAccountExternalId: string;
}): Promise<string> {
  const { args, entityId, accountExternalType, txn, financialAccountExternalId } = params;
  const accountMapping = await findMapping(
    args.db,
    args.connectionId,
    accountExternalType,
    financialAccountExternalId,
  );
  if (accountMapping) return accountMapping.internalEntityId;

  // Mutations can reference archived accounts that financial_accounts omits.
  // Create a stub so the statement line still lands in WeldBooks.
  const stub = await upsertByMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: accountExternalType,
    externalEntityId: financialAccountExternalId,
    internalEntityType: 'bank_account',
    table: schema.bankAccounts,
    idPrefix: 'ba',
    dedupColumn: null,
    values: {
      entityId,
      name: `Moneybird account ${financialAccountExternalId}`,
      currency: pickCurrency(txn.values) ?? 'EUR',
      isActive: false,
      metadata: { stubFromMutation: true, moneybirdFinancialAccountId: financialAccountExternalId },
    },
    checksum: `stub:${financialAccountExternalId}`,
  });
  return stub.internalId;
}

async function ingestBankTransactionRecord(params: {
  args: IngestArgs;
  entityId: string;
  accountExternalType: string;
  txn: MappedBankTransaction;
  externalId: string;
  checksum: string;
  counts: IngestCounts;
}): Promise<void> {
  const { args, entityId, accountExternalType, txn, externalId, checksum, counts } = params;
  if (!txn.financialAccountExternalId) {
    throw new Error('Bank transaction is missing financial_account_id');
  }
  const bankAccountId = await resolveBankAccountId({
    args,
    entityId,
    accountExternalType,
    txn,
    financialAccountExternalId: txn.financialAccountExternalId,
  });

  const outcome = await upsertByMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: args.sync.externalEntityType,
    externalEntityId: externalId,
    internalEntityType: 'bank_transaction',
    table: schema.bankTransactions,
    idPrefix: 'bt',
    dedupColumn: null,
    values: {
      ...txn.values,
      entityId,
      bankAccountId,
    },
    checksum,
  });
  tallyOutcome(counts, outcome.action);
  await publishUpsertEvent(args, 'bank_transaction', outcome);
}

async function ingestBankRecords(args: IngestArgs): Promise<IngestResult> {
  const entityId = await resolveIngestEntityId(args);
  if (!entityId) {
    return {
      ...emptyCounts(),
      failed: args.records.length,
      errorSamples: [
        {
          externalId: '-',
          message: 'Select a WeldBooks entity for this Moneybird connection (or set a default entity)',
        },
      ],
    };
  }

  const accountExternalType =
    getConnector(args.provider)?.syncs.find((sync) => sync.internalEntity === 'bank_account')?.externalEntityType
    ?? `${args.provider}_financial_account`;

  const fieldMappings = await loadConnectorFieldMappings(
    args.db,
    args.connectionId,
    args.sync.internalEntity,
  );

  return runIngestLoop(args.records, 'record', async (record, externalId, state) => {
    const { counts } = state;
    // Soft-delete only on explicit destroy webhooks. Inactive accounts still upsert
    // with isActive=false — Moneybird list sync omits archived accounts entirely.
    if (isDeletedRecord(record, args.forceDeleted)) {
      await deleteBankRecord(args, externalId, counts);
      return;
    }

    const mapped = mapWithFieldMappings(args, record, fieldMappings);
    if (!mapped || (mapped.entity !== 'bank_account' && mapped.entity !== 'bank_transaction')) {
      counts.failed++;
      pushErrorSample(state, externalId, 'Could not map Moneybird bank record (missing required fields)');
      return;
    }

    const checksum = await recordChecksum(record);

    if (mapped.entity === 'bank_account') {
      await ingestBankAccountRecord({ args, entityId, account: mapped as MappedBankAccount, externalId, checksum, counts });
      return;
    }

    await ingestBankTransactionRecord({
      args,
      entityId,
      accountExternalType,
      txn: mapped as MappedBankTransaction,
      externalId,
      checksum,
      counts,
    });
  });
}

function pickCurrency(values: Record<string, unknown>): string | null {
  const raw = values.currency;
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 3) : null;
}

const WMS_ENTITIES = new Set([
  'inventory',
  'warehouse',
  'location',
  'picklist',
  'shipment',
  'supplier',
  'purchase_order',
  'return',
  'stock_count',
  'inventory_movement',
]);

function isWmsEntity(entity: string): boolean {
  return WMS_ENTITIES.has(entity);
}

function wmsTarget(entity: MappedWmsEntity['entity']): {
  table: PgTable;
  idPrefix: string;
  dedupColumn: string | null;
  /** Stored on integration_entity_mappings.internalEntityType */
  internalEntityType: string;
  /** publishEntityEventRaw entity key */
  eventEntityType:
    | 'inventory'
    | 'warehouse'
    | 'wms_location'
    | 'picklist'
    | 'shipment'
    | 'supplier'
    | 'purchase_order'
    | 'return'
    | 'wms_cycle_count'
    | 'wms_inventory_movement';
} {
  switch (entity) {
    case 'inventory':
      return {
        table: schema.inventory,
        idPrefix: 'inv',
        dedupColumn: null,
        internalEntityType: 'inventory',
        eventEntityType: 'inventory',
      };
    case 'warehouse':
      return {
        table: schema.warehouses,
        idPrefix: 'wh',
        dedupColumn: 'code',
        internalEntityType: 'warehouse',
        eventEntityType: 'warehouse',
      };
    case 'location':
      return {
        table: schema.warehouseLocations,
        idPrefix: 'wloc',
        dedupColumn: 'code',
        internalEntityType: 'location',
        eventEntityType: 'wms_location',
      };
    case 'picklist':
      return {
        table: schema.pickLists,
        idPrefix: 'pl',
        dedupColumn: 'pickListNumber',
        internalEntityType: 'picklist',
        eventEntityType: 'picklist',
      };
    case 'shipment':
      return {
        table: schema.shipments,
        idPrefix: 'shp',
        dedupColumn: 'shipmentNumber',
        internalEntityType: 'shipment',
        eventEntityType: 'shipment',
      };
    case 'supplier':
      return {
        table: schema.suppliers,
        idPrefix: 'sup',
        dedupColumn: 'code',
        internalEntityType: 'supplier',
        eventEntityType: 'supplier',
      };
    case 'purchase_order':
      return {
        table: schema.purchaseOrders,
        idPrefix: 'po',
        dedupColumn: 'poNumber',
        internalEntityType: 'purchase_order',
        eventEntityType: 'purchase_order',
      };
    case 'return':
      return {
        table: schema.returns,
        idPrefix: 'ret',
        dedupColumn: 'returnNumber',
        internalEntityType: 'return',
        eventEntityType: 'return',
      };
    case 'stock_count':
      return {
        table: schema.cycleCounts,
        idPrefix: 'cc',
        dedupColumn: 'countNumber',
        internalEntityType: 'stock_count',
        eventEntityType: 'wms_cycle_count',
      };
    case 'inventory_movement':
      return {
        table: schema.inventoryMovements,
        idPrefix: 'imv',
        dedupColumn: 'movementNumber',
        internalEntityType: 'inventory_movement',
        eventEntityType: 'wms_inventory_movement',
      };
  }
}

async function ensureDefaultWarehouse(db: Database, ownerHint?: string | null): Promise<string> {
  const [existing] = await db
    .select({ id: schema.warehouses.id })
    .from(schema.warehouses)
    .where(isNull(schema.warehouses.deletedAt))
    .orderBy(asc(schema.warehouses.createdAt))
    .limit(1);
  if (existing) return existing.id;
  const id = generateId('wh');
  await db.insert(schema.warehouses).values({
    id,
    name: 'Default warehouse',
    code: 'DEFAULT',
    isDefault: true,
    isActive: true,
    metadata: { source: 'picqer-connector', createdFor: ownerHint ?? 'sync' },
  });
  return id;
}

function expandWmsRecords(
  provider: string,
  entity: string,
  records: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (provider !== 'picqer' || entity !== 'inventory') return records;
  return records.flatMap((record) => {
    if (Array.isArray(record.stock)) return expandPicqerProductStock(record);
    return [record];
  });
}

/** Internal id of the mapped `<provider>_<kind>` record, or null when unlinked/unmapped. */
async function linkedInternalId(
  args: { db: Database; connectionId: string; provider: string },
  externalId: string | null | undefined,
  kind: string,
): Promise<string | null> {
  if (!externalId) return null;
  const mapping = await findMapping(args.db, args.connectionId, `${args.provider}_${kind}`, externalId);
  return mapping?.internalEntityId ?? null;
}

function warehouseLinkFields(entity: MappedWmsEntity['entity'], warehouseId: string): Record<string, unknown> {
  if (entity === 'inventory_movement') {
    return { warehouseId, sourceWarehouseId: warehouseId, destWarehouseId: warehouseId };
  }
  return { warehouseId };
}

function locationLinkFields(entity: MappedWmsEntity['entity'], locationId: string): Record<string, unknown> {
  if (entity === 'stock_count') return { locationId, locationIds: [locationId] };
  return { locationId };
}

function orderLinkFields(entity: MappedWmsEntity['entity'], orderId: string): Record<string, unknown> {
  if (entity === 'picklist') return { orderIds: [orderId] };
  if (entity === 'return') return { originalOrderId: orderId };
  return {};
}

async function resolveLinkedIds(args: {
  db: Database;
  connectionId: string;
  provider: string;
  mapped: MappedWmsEntity;
}): Promise<Record<string, unknown>> {
  const extra: Record<string, unknown> = {};
  const links = args.mapped.links ?? {};
  const entity = args.mapped.entity;

  const productId = await linkedInternalId(args, links.productExternalId, 'product');
  if (productId) extra.productId = productId;

  const warehouseId = await linkedInternalId(args, links.warehouseExternalId, 'warehouse');
  if (warehouseId) Object.assign(extra, warehouseLinkFields(entity, warehouseId));

  const locationId = await linkedInternalId(args, links.locationExternalId, 'location');
  if (locationId) Object.assign(extra, locationLinkFields(entity, locationId));

  const supplierId = await linkedInternalId(args, links.supplierExternalId, 'supplier');
  if (supplierId) extra.supplierId = supplierId;

  const orderId = await linkedInternalId(args, links.orderExternalId, 'order');
  if (orderId) Object.assign(extra, orderLinkFields(entity, orderId));

  const picklistId = await linkedInternalId(args, links.picklistExternalId, 'picklist');
  if (picklistId) {
    extra.metadata = {
      ...(args.mapped.values.metadata as Record<string, unknown> | undefined),
      pickListId: picklistId,
    };
  }
  return extra;
}

const WAREHOUSE_DEFAULT_ENTITIES = new Set<string>(['inventory', 'picklist', 'stock_count', 'location']);

/**
 * Fill warehouse defaults on a WMS row. Returns false when the row cannot be
 * ingested (inventory / movement rows need a linked product).
 */
function applyWmsDefaults(
  entity: MappedWmsEntity['entity'],
  values: Record<string, unknown>,
  defaultWarehouseId: string,
): boolean {
  if (WAREHOUSE_DEFAULT_ENTITIES.has(entity) && !values.warehouseId) {
    values.warehouseId = defaultWarehouseId;
  }
  if ((entity === 'inventory' || entity === 'inventory_movement') && !values.productId) return false;
  if (entity === 'inventory_movement') {
    values.sourceWarehouseId = values.sourceWarehouseId ?? defaultWarehouseId;
    values.destWarehouseId = values.destWarehouseId ?? defaultWarehouseId;
  }
  return true;
}

async function deleteWmsRecord(args: IngestArgs, externalId: string, counts: IngestCounts): Promise<void> {
  const mapping = await findMapping(args.db, args.connectionId, args.sync.externalEntityType, externalId);
  if (!mapping) {
    counts.skipped++;
    return;
  }
  const target = wmsTarget(args.sync.internalEntity as MappedWmsEntity['entity']);
  await softDeleteMapped(args.db, target.table, mapping.internalEntityId, mapping.id);
  counts.deleted++;
}

async function ingestWmsRecord(params: {
  args: IngestArgs;
  wms: MappedWmsEntity;
  record: Record<string, unknown>;
  externalId: string;
  defaultWarehouseId: string;
  counts: IngestCounts;
}): Promise<void> {
  const { args, wms, record, externalId, defaultWarehouseId, counts } = params;
  const target = wmsTarget(wms.entity);
  const linked = await resolveLinkedIds({
    db: args.db,
    connectionId: args.connectionId,
    provider: args.provider,
    mapped: wms,
  });

  const values: Record<string, unknown> = {
    ...wms.values,
    ...linked,
    createdBy: wms.values.createdBy ?? args.ownerId,
  };

  if (!applyWmsDefaults(wms.entity, values, defaultWarehouseId)) {
    counts.skipped++;
    return;
  }

  const checksum = await recordChecksum(record);
  const outcome = await upsertByMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: args.sync.externalEntityType,
    externalEntityId: externalId,
    internalEntityType: target.internalEntityType,
    table: target.table,
    idPrefix: target.idPrefix,
    dedupColumn: target.dedupColumn,
    values,
    checksum,
  });

  tallyOutcome(counts, outcome.action);
  await publishUpsertEvent(args, target.eventEntityType, outcome);
}

async function ingestWmsRecords(args: IngestArgs): Promise<IngestResult> {
  const fieldMappings = await loadConnectorFieldMappings(
    args.db,
    args.connectionId,
    args.sync.internalEntity,
  );
  const records = expandWmsRecords(args.provider, args.sync.internalEntity, args.records);
  const defaultWarehouseId = await ensureDefaultWarehouse(args.db, args.ownerId);

  return runIngestLoop(records, 'wms record', async (record, externalId, { counts }) => {
    if (isDeletedRecord(record, args.forceDeleted)) {
      await deleteWmsRecord(args, externalId, counts);
      return;
    }

    const mapped = mapWithFieldMappings(args, record, fieldMappings);
    if (!mapped || !('entity' in mapped) || !isWmsEntity(mapped.entity)) {
      counts.skipped++;
      return;
    }
    await ingestWmsRecord({ args, wms: mapped as MappedWmsEntity, record, externalId, defaultWarehouseId, counts });
  });
}

type CatalogTarget = ReturnType<typeof targetFor>;

async function deleteCatalogRecord(
  args: IngestArgs,
  target: CatalogTarget,
  externalId: string,
  counts: IngestCounts,
): Promise<void> {
  const mapping = await findMapping(args.db, args.connectionId, args.sync.externalEntityType, externalId);
  if (!mapping) {
    counts.skipped++;
    return;
  }

  const isProduct = args.sync.internalEntity === 'product';
  if (isProduct) await markSalesChannelDeleted(args.db, args.connectionId, externalId);
  // A product listed on another channel stays; only the last channel removes it.
  const stillListed = isProduct && (await activeSalesChannelCount(args.db, mapping.internalEntityId)) > 0;
  if (!stillListed) {
    await softDeleteMapped(args.db, target.table, mapping.internalEntityId, mapping.id);
  }
  counts.deleted++;
  await publishIngestEvent(args, target.entityType, 'deleted', mapping.internalEntityId);
}

async function buildCatalogValues(
  args: IngestArgs,
  mapped: MappedRecord,
  customerType: string,
): Promise<Record<string, unknown>> {
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
  return values;
}

function productPermalink(args: IngestArgs, mapped: MappedProduct, externalId: string): string | null {
  if (mapped.externalUrl != null) return mapped.externalUrl;
  if (!args.storeUrl) return null;
  if (args.provider === 'shopify') return `${args.storeUrl}/products/${asText(mapped.values.slug ?? '')}`;
  return `${args.storeUrl}/?p=${externalId}`;
}

async function syncProductListing(
  args: IngestArgs,
  mapped: MappedProduct,
  externalId: string,
  outcome: UpsertOutcome,
): Promise<void> {
  await upsertSalesChannel({
    db: args.db,
    productId: outcome.internalId,
    connectionId: args.connectionId,
    provider: args.provider,
    displayName: args.displayName,
    externalId,
    externalUrl: productPermalink(args, mapped, externalId),
    price: mapped.values.price != null ? asText(mapped.values.price) : null,
    listingStatus: typeof mapped.values.status === 'string' ? mapped.values.status : null,
  });
  if (mapped.variants?.length && outcome.action !== 'skipped') {
    await upsertProductVariants(args.db, outcome.internalId, mapped.variants);
  }
}

async function ingestCatalogRecords(args: IngestArgs): Promise<IngestResult> {
  const target = targetFor(args.sync.internalEntity as IngestEntity);
  const customerType = `${args.provider}_customer`;
  const fieldMappings = await loadConnectorFieldMappings(
    args.db,
    args.connectionId,
    args.sync.internalEntity,
  );

  return runIngestLoop(args.records, 'record', async (record, externalId, { counts }) => {
    if (isDeletedRecord(record, args.forceDeleted)) {
      await deleteCatalogRecord(args, target, externalId, counts);
      return;
    }

    const mapped = mapWithFieldMappings(args, record, fieldMappings);
    if (!mapped) {
      counts.skipped++;
      return;
    }

    const values = await buildCatalogValues(args, mapped, customerType);
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
      await syncProductListing(args, mapped, externalId, outcome);
    }

    tallyOutcome(counts, outcome.action);
    await publishUpsertEvent(args, target.entityType, outcome);
  });
}

export async function ingestRecords(args: IngestArgs): Promise<IngestResult> {
  const entity = args.sync.internalEntity;
  if (entity === 'party' || entity === 'invoice' || entity === 'bill') {
    return ingestAccountingRecords(args);
  }
  if (entity === 'bank_account' || entity === 'bank_transaction') {
    return ingestBankRecords(args);
  }
  if (isWmsEntity(entity)) {
    return ingestWmsRecords(args);
  }
  return ingestCatalogRecords(args);
}
