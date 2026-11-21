/**
 * pglite ingest of store orders: re-importing an order keeps its items
 * (WeldStash pick lists point at them and WeldStash owns `fulfilledQuantity`),
 * matches items imported before line ids were kept, and gives the order the
 * buyer's party as counterparty for WeldBooks. The same scenarios run through
 * the sync route in connect-api's `sync.test.ts` (and against Rust there).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getConnector } from '@weldsuite/connectors';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ingestRecords } from './ingest';

let db: Database;

const CONN = 'ccn_ingorders0001';
const at = new Date('2026-04-01T09:00:00.000Z');
const ordersSync = getConnector('woocommerce')!.syncs.find((s) => s.settingKey === 'orders')!;

const line = (id: number, name: string, sku: string, quantity: number, price: number) => ({
  id,
  product_id: 0,
  name,
  sku,
  quantity,
  price,
  total: (quantity * price).toFixed(2),
});

const order = (id: number, modified: string, lines: Array<Record<string, unknown>>) => ({
  id,
  number: String(id),
  status: 'processing',
  currency: 'EUR',
  total: '100.00',
  customer_id: 41,
  date_modified_gmt: modified,
  billing: { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
  line_items: lines,
});

function ingest(records: Array<Record<string, unknown>>) {
  return ingestRecords({
    db,
    connectionId: CONN,
    provider: 'woocommerce',
    displayName: 'Orders shop',
    storeUrl: 'https://orders.example',
    sync: ordersSync,
    records,
    ownerId: 'user_1',
    workspaceId: 'ws_1',
    env: {},
  });
}

async function orderByNumber(number: string) {
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.orderNumber, number));
  return row!;
}

async function itemsOf(orderId: string) {
  return db
    .select()
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, orderId))
    .orderBy(asc(schema.orderItems.createdAt), asc(schema.orderItems.id));
}

/** Items inserted in one pass can share a creation time, so compare them by name. */
function byName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.connectorConnections).values({
    id: CONN,
    provider: 'woocommerce',
    displayName: 'Orders shop',
    status: 'active',
    externalAccountId: 'https://orders.example',
  });
  // The buyer, imported earlier by the customers sync.
  await db.insert(schema.people).values({
    id: 'pers_ingbuyer001',
    displayName: 'Grace Hopper',
    firstName: 'Grace',
    lastName: 'Hopper',
    email: 'grace@example.com',
    primaryAddress: { line1: 'Navy Yard 1', city: 'Arlington', country: 'US' },
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(schema.integrationEntityMappings).values({
    id: 'iem_ingbuyer0001',
    connectionId: CONN,
    externalEntityType: 'woocommerce_customer',
    externalEntityId: '41',
    internalEntityType: 'person',
    internalEntityId: 'pers_ingbuyer001',
    syncChecksum: 'seen',
    lastSyncedAt: at,
  });
}, 60_000);

describe('connector ingest · re-importing a store order', () => {
  it('updates items in place, keeps fulfilled and picked lines, and links the buyer once', async () => {
    await ingest([
      order(701, '2026-04-01T10:00:00', [
        line(9001, 'Kettle', 'KET-1', 2, 30),
        line(9002, 'Cup', 'CUP-1', 4, 5),
        line(9003, 'Saucer', 'SAU-1', 1, 3),
      ]),
    ]);

    const first = await orderByNumber('701');
    expect(first).toMatchObject({ personId: 'pers_ingbuyer001', itemCount: 3, totalQuantity: 7 });
    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.personId, 'pers_ingbuyer001'));
    expect(party).toMatchObject({ kind: 'person', role: 'customer', displayName: 'Grace Hopper', deletedAt: null });
    expect(first.counterpartyId).toBe(party!.id);

    const before = byName(await itemsOf(first.id));
    expect(before.map((i) => [i.name, i.quantity, i.properties])).toEqual([
      ['Cup', 4, { externalLineId: '9002' }],
      ['Kettle', 2, { externalLineId: '9001' }],
      ['Saucer', 1, { externalLineId: '9003' }],
    ]);
    const [cup, kettle, saucer] = before;

    // WeldStash ships one kettle and puts the cups on a pick list; someone
    // then picks another invoice contact for the order.
    await db.update(schema.orderItems).set({ fulfilledQuantity: 2 }).where(eq(schema.orderItems.id, kettle!.id));
    await db.insert(schema.pickLists).values({ id: 'pl_ingorders0001', pickListNumber: 'PL-INGORDERS', warehouseId: 'wh_ingorders0001' });
    await db.insert(schema.pickListItems).values({
      id: 'pli_ingorders001',
      pickListId: 'pl_ingorders0001',
      orderId: first.id,
      orderItemId: cup!.id,
      productId: 'prd_ingorders001',
      sku: 'CUP-1',
      name: 'Cup',
      quantityRequired: 4,
    });
    await db.insert(schema.parties).values({ id: 'party_ingchosen1', kind: 'company', displayName: 'Hopper Holdings', createdAt: at, updatedAt: at });
    await db.update(schema.orders).set({ counterpartyId: 'party_ingchosen1' }).where(eq(schema.orders.id, first.id));

    // The store raises the kettles to three, drops the cups and the saucer and adds a lid.
    await ingest([
      order(701, '2026-04-02T10:00:00', [
        line(9001, 'Kettle', 'KET-1', 3, 30),
        line(9004, 'Lid', 'LID-1', 1, 2),
      ]),
    ]);

    const after = byName(await itemsOf(first.id));
    expect(after.map((i) => [i.id, i.name, i.quantity, i.fulfilledQuantity, i.properties])).toEqual([
      [cup!.id, 'Cup', 4, 0, { externalLineId: '9002' }],
      [kettle!.id, 'Kettle', 3, 2, { externalLineId: '9001' }],
      [after[2]!.id, 'Lid', 1, 0, { externalLineId: '9004' }],
    ]);
    // The saucer (unfulfilled, on no pick list) is gone; the lid is new.
    expect([kettle!.id, cup!.id, saucer!.id]).not.toContain(after[2]!.id);

    const second = await orderByNumber('701');
    expect(second).toMatchObject({ id: first.id, itemCount: 3, totalQuantity: 8, counterpartyId: 'party_ingchosen1' });
    expect(await db.select().from(schema.parties).where(eq(schema.parties.personId, 'pers_ingbuyer001'))).toHaveLength(1);
  });

  it('matches items imported before line ids were kept, one to one, and stamps them', async () => {
    await db.insert(schema.orders).values({
      id: 'ord_inglegacy001',
      orderNumber: '702',
      externalOrderId: '702',
      source: 'woocommerce',
      status: 'processing',
      subtotal: '0',
      total: '0',
      itemCount: 3,
      totalQuantity: 3,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(schema.integrationEntityMappings).values({
      id: 'iem_inglegacy001',
      connectionId: CONN,
      externalEntityType: 'woocommerce_order',
      externalEntityId: '702',
      internalEntityType: 'order',
      internalEntityId: 'ord_inglegacy001',
      syncChecksum: 'before-line-ids',
      lastSyncedAt: at,
    });
    await db.insert(schema.orderItems).values([
      { id: 'oitm_inglegacy01', orderId: 'ord_inglegacy001', sku: 'MAT-1', name: 'Mat', quantity: 1, unitPrice: '10', total: '10', fulfilledQuantity: 1, createdAt: new Date('2026-04-01T10:00:00.000Z') },
      { id: 'oitm_inglegacy02', orderId: 'ord_inglegacy001', sku: 'MAT-1', name: 'Mat', quantity: 1, unitPrice: '10', total: '10', createdAt: new Date('2026-04-01T10:00:01.000Z') },
      { id: 'oitm_inglegacy03', orderId: 'ord_inglegacy001', sku: 'RUG-1', name: 'Rug', quantity: 1, unitPrice: '40', total: '40', createdAt: new Date('2026-04-01T10:00:02.000Z') },
    ]);

    await ingest([
      order(702, '2026-04-03T10:00:00', [
        line(9101, 'Mat', 'MAT-1', 1, 10),
        line(9102, 'Mat', 'MAT-1', 2, 10),
        line(9103, 'Rug', 'RUG-1', 1, 40),
      ]),
    ]);

    const items = await itemsOf('ord_inglegacy001');
    expect(items.map((i) => [i.id, i.quantity, i.fulfilledQuantity, i.properties])).toEqual([
      ['oitm_inglegacy01', 1, 1, { externalLineId: '9101' }],
      ['oitm_inglegacy02', 2, 0, { externalLineId: '9102' }],
      ['oitm_inglegacy03', 1, 0, { externalLineId: '9103' }],
    ]);
  });
});
