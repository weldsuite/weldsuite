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
import { getConnector, type ConnectorSyncDef } from '@weldsuite/connectors';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { promoteAccountingRole } from '../accounting-roles';
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
  /** WeldBooks accounting entity for invoice/bill/bank rows. */
  entityId?: string | null;
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

function targetFor(entity: 'product' | 'order' | 'person'): {
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

async function upsertParty(args: {
  db: Database;
  connectionId: string;
  provider: string;
  ownerId: string;
  mapped: MappedParty;
  checksum: string;
}): Promise<UpsertOutcome> {
  const externalType = partySyncExternalType(args.provider);
  const mapping = await findMapping(args.db, args.connectionId, externalType, args.mapped.externalId);
  const identityTable = args.mapped.kind === 'company' ? schema.companies : schema.people;
  const identityCols = identityTable as unknown as Record<string, any>;
  const identityValues = {
    ...args.mapped.identity,
    ownerId: args.ownerId,
    updatedAt: new Date(),
  };

  if (mapping) {
    if (
      (
        await args.db
          .select({ syncChecksum: schema.integrationEntityMappings.syncChecksum })
          .from(schema.integrationEntityMappings)
          .where(eq(schema.integrationEntityMappings.id, mapping.id))
          .limit(1)
      )[0]?.syncChecksum === args.checksum
    ) {
      return { action: 'skipped', internalId: mapping.internalEntityId };
    }
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
            .where(eq(identityCols.id, identityId)),
        );
      }
      return statements;
    });
    return { action: 'updated', internalId: mapping.internalEntityId };
  }

  const email = typeof args.mapped.identity.email === 'string' ? args.mapped.identity.email : null;
  const vatNumber = typeof args.mapped.identity.vatNumber === 'string' ? args.mapped.identity.vatNumber : null;
  let identityId =
    (email ? await findIdentityByEmail(args.db, identityTable, email) : null)
    ?? (args.mapped.kind === 'company' && vatNumber ? await findCompanyByVat(args.db, vatNumber) : null);

  if (!identityId) {
    identityId = generateId(args.mapped.kind === 'company' ? 'company' : 'person');
    const displayName = String(args.mapped.identity.displayName ?? args.mapped.values.displayName ?? 'Contact');
    await args.db.insert(identityTable).values({
      id: identityId,
      displayName,
      ...identityValues,
    } as never);
  } else {
    await args.db
      .update(identityTable)
      .set({ ...identityValues, deletedAt: null } as never)
      .where(eq(identityCols.id, identityId));
  }

  let createdParty = false;
  let partyId = await wrappingPartyId(args.db, args.mapped.kind, identityId);
  if (!partyId) {
    createdParty = true;
    partyId = generateId('party');
    await args.db.insert(schema.parties).values({
      id: partyId,
      kind: args.mapped.kind,
      companyId: args.mapped.kind === 'company' ? identityId : null,
      personId: args.mapped.kind === 'person' ? identityId : null,
      ownerId: args.ownerId,
      ...args.mapped.values,
    } as never);
  } else {
    await args.db
      .update(schema.parties)
      .set({ ...args.mapped.values, deletedAt: null, updatedAt: new Date() } as never)
      .where(eq(schema.parties.id, partyId));
  }

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

  return { action: createdParty ? 'created' : 'updated', internalId: partyId };
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
  if (!mapped || mapped.entity !== 'party') return null;
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

async function ingestAccountingRecords(args: IngestArgs): Promise<IngestResult> {
  const counts = emptyCounts();
  const errorSamples: IngestResult['errorSamples'] = [];
  const entityId = args.sync.internalEntity === 'party' ? null : await resolveIngestEntityId(args);

  for (const record of args.records) {
    const externalId = externalIdOf(record);
    if (!externalId) {
      counts.skipped++;
      continue;
    }

    try {
      if (isDeletedRecord(record, args.forceDeleted)) {
        const mapping = await findMapping(args.db, args.connectionId, args.sync.externalEntityType, externalId);
        if (!mapping) {
          counts.skipped++;
          continue;
        }
        if (args.sync.internalEntity === 'party') {
          const [party] = await args.db
            .select({ kind: schema.parties.kind })
            .from(schema.parties)
            .where(eq(schema.parties.id, mapping.internalEntityId))
            .limit(1);
          await softDeleteParty(args.db, mapping.internalEntityId, mapping.id);
          counts.deleted++;
          await publishEntityEventRaw({
            env: args.env as never,
            db: args.db as never,
            workspaceId: args.workspaceId,
            userId: args.ownerId,
            entityType: party?.kind === 'person' ? 'person' : 'company',
            action: 'deleted',
            entityId: mapping.internalEntityId,
            data: { id: mapping.internalEntityId },
          });
          continue;
        }
        const table = args.sync.internalEntity === 'invoice' ? schema.invoices : schema.bills;
        await softDeleteMapped(args.db, table, mapping.internalEntityId, mapping.id);
        counts.deleted++;
        await publishEntityEventRaw({
          env: args.env as never,
          db: args.db as never,
          workspaceId: args.workspaceId,
          userId: args.ownerId,
          entityType: args.sync.internalEntity,
          action: 'deleted',
          entityId: mapping.internalEntityId,
          data: { id: mapping.internalEntityId },
        });
        continue;
      }

      const mapped = mapConnectorRecord(args.sync.internalEntity, record, args.provider);
      if (!mapped) {
        counts.skipped++;
        continue;
      }

      const checksum = await recordChecksum(record);

      if (mapped.entity === 'party') {
        const outcome = await upsertParty({
          db: args.db,
          connectionId: args.connectionId,
          provider: args.provider,
          ownerId: args.ownerId,
          mapped,
          checksum,
        });
        if (outcome.action === 'created') counts.created++;
        else if (outcome.action === 'updated') counts.modified++;
        else counts.skipped++;
        if (outcome.action !== 'skipped') {
          await publishEntityEventRaw({
            env: args.env as never,
            db: args.db as never,
            workspaceId: args.workspaceId,
            userId: args.ownerId,
            entityType: mapped.kind,
            action: outcome.action === 'created' ? 'created' : 'updated',
            entityId: outcome.internalId,
            data: { id: outcome.internalId },
          });
        }
        continue;
      }

      if (!entityId) {
        throw new Error('Select a WeldBooks entity for this Moneybird connection (or set a default entity)');
      }

      const document = mapped as MappedInvoice | MappedBill;
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

      const table = document.entity === 'invoice' ? schema.invoices : schema.bills;
      const idPrefix = document.entity === 'invoice' ? 'inv' : 'bil';
      const outcome = await upsertByMapping({
        db: args.db,
        connectionId: args.connectionId,
        externalEntityType: args.sync.externalEntityType,
        externalEntityId: externalId,
        internalEntityType: document.entity,
        table,
        idPrefix,
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
        await publishEntityEventRaw({
          env: args.env as never,
          db: args.db as never,
          workspaceId: args.workspaceId,
          userId: args.ownerId,
          entityType: document.entity,
          action: outcome.action === 'created' ? 'created' : 'updated',
          entityId: outcome.internalId,
          data: { id: outcome.internalId },
        });
      }

      if (outcome.action === 'created') counts.created++;
      else if (outcome.action === 'updated') counts.modified++;
      else counts.skipped++;
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

async function ingestBankRecords(args: IngestArgs): Promise<IngestResult> {
  const counts = emptyCounts();
  const errorSamples: IngestResult['errorSamples'] = [];
  const entityId = await resolveIngestEntityId(args);
  if (!entityId) {
    return {
      ...counts,
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

  for (const record of args.records) {
    const externalId = externalIdOf(record);
    if (!externalId) {
      counts.skipped++;
      continue;
    }

    try {
      // Soft-delete only on explicit destroy webhooks. Inactive accounts still upsert
      // with isActive=false — Moneybird list sync omits archived accounts entirely.
      if (isDeletedRecord(record, args.forceDeleted)) {
        const mapping = await findMapping(args.db, args.connectionId, args.sync.externalEntityType, externalId);
        if (!mapping) {
          counts.skipped++;
          continue;
        }
        const table =
          args.sync.internalEntity === 'bank_account' ? schema.bankAccounts : schema.bankTransactions;
        await softDeleteMapped(args.db, table, mapping.internalEntityId, mapping.id);
        counts.deleted++;
        await publishEntityEventRaw({
          env: args.env as never,
          db: args.db as never,
          workspaceId: args.workspaceId,
          userId: args.ownerId,
          entityType: args.sync.internalEntity === 'bank_account' ? 'bank_account' : 'bank_transaction',
          action: 'deleted',
          entityId: mapping.internalEntityId,
          data: { id: mapping.internalEntityId },
        });
        continue;
      }

      const mapped = mapConnectorRecord(args.sync.internalEntity, record, args.provider);
      if (!mapped || (mapped.entity !== 'bank_account' && mapped.entity !== 'bank_transaction')) {
        counts.failed++;
        if (errorSamples.length < MAX_ERROR_SAMPLES) {
          errorSamples.push({
            externalId,
            message: 'Could not map Moneybird bank record (missing required fields)',
          });
        }
        continue;
      }

      const checksum = await recordChecksum(record);

      if (mapped.entity === 'bank_account') {
        const account = mapped as MappedBankAccount;
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
        if (outcome.action === 'created') counts.created++;
        else if (outcome.action === 'updated') counts.modified++;
        else counts.skipped++;
        if (outcome.action !== 'skipped') {
          await publishEntityEventRaw({
            env: args.env as never,
            db: args.db as never,
            workspaceId: args.workspaceId,
            userId: args.ownerId,
            entityType: 'bank_account',
            action: outcome.action === 'created' ? 'created' : 'updated',
            entityId: outcome.internalId,
            data: { id: outcome.internalId },
          });
        }
        continue;
      }

      const txn = mapped as MappedBankTransaction;
      if (!txn.financialAccountExternalId) {
        throw new Error('Bank transaction is missing financial_account_id');
      }
      let accountMapping = await findMapping(
        args.db,
        args.connectionId,
        accountExternalType,
        txn.financialAccountExternalId,
      );
      // Mutations can reference archived accounts that financial_accounts omits.
      // Create a stub so the statement line still lands in WeldBooks.
      if (!accountMapping) {
        const stub = await upsertByMapping({
          db: args.db,
          connectionId: args.connectionId,
          externalEntityType: accountExternalType,
          externalEntityId: txn.financialAccountExternalId,
          internalEntityType: 'bank_account',
          table: schema.bankAccounts,
          idPrefix: 'ba',
          dedupColumn: null,
          values: {
            entityId,
            name: `Moneybird account ${txn.financialAccountExternalId}`,
            currency: pickCurrency(txn.values) ?? 'EUR',
            isActive: false,
            metadata: { stubFromMutation: true, moneybirdFinancialAccountId: txn.financialAccountExternalId },
          },
          checksum: `stub:${txn.financialAccountExternalId}`,
        });
        accountMapping = { id: '', internalEntityId: stub.internalId };
      }

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
          bankAccountId: accountMapping.internalEntityId,
        },
        checksum,
      });
      if (outcome.action === 'created') counts.created++;
      else if (outcome.action === 'updated') counts.modified++;
      else counts.skipped++;
      if (outcome.action !== 'skipped') {
        await publishEntityEventRaw({
          env: args.env as never,
          db: args.db as never,
          workspaceId: args.workspaceId,
          userId: args.ownerId,
          entityType: 'bank_transaction',
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

function pickCurrency(values: Record<string, unknown>): string | null {
  const raw = values.currency;
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 3) : null;
}

export async function ingestRecords(args: IngestArgs): Promise<IngestResult> {
  if (
    args.sync.internalEntity === 'party'
    || args.sync.internalEntity === 'invoice'
    || args.sync.internalEntity === 'bill'
  ) {
    return ingestAccountingRecords(args);
  }
  if (
    args.sync.internalEntity === 'bank_account'
    || args.sync.internalEntity === 'bank_transaction'
  ) {
    return ingestBankRecords(args);
  }

  const counts = emptyCounts();
  const errorSamples: IngestResult['errorSamples'] = [];
  const target = targetFor(args.sync.internalEntity as 'product' | 'order' | 'person');
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
          price: mapped.values.price != null ? String(mapped.values.price) : null,
          listingStatus: typeof mapped.values.status === 'string' ? mapped.values.status : null,
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
