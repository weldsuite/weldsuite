/**
 * pglite ingest: sales channels, multi-store SKU sharing, delete-one-store.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getConnector } from '@weldsuite/connectors';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { ingestRecords } from './ingest';

let db: Database;

const productsSync = getConnector('woocommerce')!.syncs.find((s) => s.settingKey === 'products')!;

async function insertStore(id: string, account: string, name: string) {
  await db.insert(schema.connectorConnections).values({
    id,
    provider: 'woocommerce',
    displayName: name,
    status: 'active',
    externalAccountId: account,
  });
}

function productPayload(id: number, sku: string, name: string) {
  return {
    id,
    name,
    slug: sku.toLowerCase(),
    sku,
    price: '10.00',
    status: 'publish',
  };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('connector ingest · sales channels', () => {
  it('shares one product across two stores and only deletes it after the last listing is gone', async () => {
    await insertStore('conn_store_a', 'https://a.example', 'Store A');
    await insertStore('conn_store_b', 'https://b.example', 'Store B');

    const env = {};
    const first = await ingestRecords({
      db,
      connectionId: 'conn_store_a',
      provider: 'woocommerce',
      displayName: 'Store A',
      storeUrl: 'https://a.example',
      sync: productsSync,
      records: [productPayload(11, 'WH-SHARED', 'Helmet')],
      ownerId: 'user_1',
      workspaceId: 'ws_1',
      env,
    });
    expect(first.created).toBe(1);

    const second = await ingestRecords({
      db,
      connectionId: 'conn_store_b',
      provider: 'woocommerce',
      displayName: 'Store B',
      storeUrl: 'https://b.example',
      sync: productsSync,
      records: [productPayload(22, 'WH-SHARED', 'Helmet')],
      ownerId: 'user_1',
      workspaceId: 'ws_1',
      env,
    });
    expect(second.created).toBe(0);
    expect(second.modified).toBe(1);

    const products = await db.select().from(schema.products).where(eq(schema.products.sku, 'WH-SHARED'));
    expect(products).toHaveLength(1);
    expect(products[0]?.deletedAt).toBeNull();

    const channels = await db
      .select()
      .from(schema.productSalesChannels)
      .where(eq(schema.productSalesChannels.productId, products[0]!.id));
    expect(channels).toHaveLength(2);
    expect(channels.map((row) => row.externalId).sort()).toEqual(['11', '22']);
    expect(channels.every((row) => row.status === 'active')).toBe(true);
    expect(channels.every((row) => row.price === '10.00')).toBe(true);
    expect(channels.every((row) => row.listingStatus === 'active')).toBe(true);

    const deleteA = await ingestRecords({
      db,
      connectionId: 'conn_store_a',
      provider: 'woocommerce',
      displayName: 'Store A',
      storeUrl: 'https://a.example',
      sync: productsSync,
      records: [{ id: 11, sku: 'WH-SHARED' }],
      ownerId: 'user_1',
      workspaceId: 'ws_1',
      env,
      forceDeleted: true,
    });
    expect(deleteA.deleted).toBe(1);

    const [afterOne] = await db.select().from(schema.products).where(eq(schema.products.id, products[0]!.id));
    expect(afterOne?.deletedAt).toBeNull();
    const channelsAfterOne = await db
      .select()
      .from(schema.productSalesChannels)
      .where(eq(schema.productSalesChannels.productId, products[0]!.id));
    expect(channelsAfterOne.find((row) => row.externalId === '11')?.status).toBe('deleted_remote');
    expect(channelsAfterOne.find((row) => row.externalId === '22')?.status).toBe('active');

    const deleteB = await ingestRecords({
      db,
      connectionId: 'conn_store_b',
      provider: 'woocommerce',
      displayName: 'Store B',
      storeUrl: 'https://b.example',
      sync: productsSync,
      records: [{ id: 22, sku: 'WH-SHARED' }],
      ownerId: 'user_1',
      workspaceId: 'ws_1',
      env,
      forceDeleted: true,
    });
    expect(deleteB.deleted).toBe(1);

    const [afterBoth] = await db.select().from(schema.products).where(eq(schema.products.id, products[0]!.id));
    expect(afterBoth?.deletedAt).not.toBeNull();
  });
});

describe('connector ingest · Moneybird accounting', () => {
  const moneybird = getConnector('moneybird')!;
  const contactsSync = moneybird.syncs.find((s) => s.syncName === 'moneybird-contacts')!;
  const invoicesSync = moneybird.syncs.find((s) => s.syncName === 'moneybird-sales-invoices')!;

  it('imports a contact then an invoice with party FK and no journal row', async () => {
    await db.insert(schema.connectorConnections).values({
      id: 'conn_mb',
      provider: 'moneybird',
      displayName: 'Moneybird',
      status: 'active',
      externalAccountId: 'admin_1',
    });
    await db.insert(schema.entities).values({
      id: 'ent_1',
      name: 'Weld BV',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
    });
    const [existingSettings] = await db.select({ id: schema.settings.id }).from(schema.settings).limit(1);
    if (existingSettings) {
      await db
        .update(schema.settings)
        .set({ defaultEntityId: 'ent_1', updatedAt: new Date() })
        .where(eq(schema.settings.id, existingSettings.id));
    } else {
      await db.insert(schema.settings).values({
        id: 'set_1',
        defaultEntityId: 'ent_1',
      });
    }

    const env = {};
    const contact = await ingestRecords({
      db,
      connectionId: 'conn_mb',
      provider: 'moneybird',
      displayName: 'Moneybird',
      sync: contactsSync,
      records: [{ id: 'c1', company_name: 'Acme BV', email: 'info@acme.test' }],
      ownerId: 'user_1',
      workspaceId: 'ws_1',
      env,
    });
    expect(contact.created).toBe(1);

    const parties = await db.select().from(schema.parties);
    expect(parties).toHaveLength(1);
    expect(parties[0]?.kind).toBe('company');

    const invoice = await ingestRecords({
      db,
      connectionId: 'conn_mb',
      provider: 'moneybird',
      displayName: 'Moneybird',
      sync: invoicesSync,
      records: [
        {
          id: 'inv1',
          invoice_id: '2024-0001',
          state: 'open',
          contact_id: 'c1',
          invoice_date: '2024-01-15',
          due_date: '2024-01-29',
          total_price_excl_tax: '100',
          total_price_incl_tax: '121',
          details: [{ description: 'Hours', amount: '1', price: '100' }],
        },
      ],
      ownerId: 'user_1',
      workspaceId: 'ws_1',
      env,
    });
    expect(invoice.created).toBe(1);

    const invoices = await db.select().from(schema.invoices);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.contactId).toBe(parties[0]?.id);
    expect(invoices[0]?.invoiceNumber).toBe('2024-0001');
    expect(invoices[0]?.journalEntryId).toBeNull();

    const journals = await db.select().from(schema.journalEntries);
    expect(journals).toHaveLength(0);

    const skip = await ingestRecords({
      db,
      connectionId: 'conn_mb',
      provider: 'moneybird',
      displayName: 'Moneybird',
      sync: invoicesSync,
      records: [
        {
          id: 'inv1',
          invoice_id: '2024-0001',
          state: 'open',
          contact_id: 'c1',
          invoice_date: '2024-01-15',
          due_date: '2024-01-29',
          total_price_excl_tax: '100',
          total_price_incl_tax: '121',
          details: [{ description: 'Hours', amount: '1', price: '100' }],
        },
      ],
      ownerId: 'user_1',
      workspaceId: 'ws_1',
      env,
    });
    expect(skip.skipped).toBe(1);

    const destroyed = await ingestRecords({
      db,
      connectionId: 'conn_mb',
      provider: 'moneybird',
      displayName: 'Moneybird',
      sync: contactsSync,
      records: [{ id: 'c1' }],
      ownerId: 'user_1',
      workspaceId: 'ws_1',
      env,
      forceDeleted: true,
    });
    expect(destroyed.deleted).toBe(1);
    const [partyAfter] = await db.select().from(schema.parties).where(eq(schema.parties.id, parties[0]!.id));
    expect(partyAfter?.deletedAt).not.toBeNull();
  });
});
