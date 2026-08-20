/**
 * DB-backed tests for pick-list generate → pick → pack → ship.
 *
 * Runs against the same pglite tenant schema as the ledger tests so allocation,
 * scan matching, and fulfillment status updates exercise real SQL.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgliteDb } from '../test/pglite';
import { createTestApp, permissions } from '../test/harness';
import { pickListsRoutes } from '../routes/pick-lists';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { applyStockChange } from './inventory-ledger';
import {
  assignPickList,
  cancelPickList,
  completePickList,
  confirmPickItem,
  generatePickList,
  getPickListWithItems,
  packPickList,
  renderPackingSlipHtml,
  shipPickList,
  startPickList,
} from './pick-lists';
import { SendcloudError, type SendcloudClient } from './sendcloud/client';

let db: Database;

async function makeWarehouse(): Promise<string> {
  const id = generateId('wh');
  await db.insert(schema.warehouses).values({
    id,
    name: `Warehouse ${id}`,
    code: id.slice(0, 12),
    isDefault: true,
    isActive: true,
  });
  return id;
}

async function makeProduct(overrides: Partial<typeof schema.products.$inferInsert> = {}): Promise<string> {
  const id = generateId('prod');
  await db.insert(schema.products).values({
    id,
    name: `Product ${id}`,
    slug: id,
    sku: `SKU-${id.slice(-8).toUpperCase()}`,
    barcode: `BAR-${id.slice(-8).toUpperCase()}`,
    price: '10.00',
    trackInventory: true,
    allowBackorder: false,
    ...overrides,
  });
  return id;
}

async function bucketFor(productId: string, warehouseId: string) {
  const [row] = await db
    .select()
    .from(schema.inventory)
    .where(
      and(
        eq(schema.inventory.productId, productId),
        eq(schema.inventory.warehouseId, warehouseId),
        isNull(schema.inventory.deletedAt),
      ),
    )
    .limit(1);
  return row;
}

async function seedShippableOrder(params?: { quantity?: number; stock?: number }) {
  const quantity = params?.quantity ?? 3;
  const stock = params?.stock ?? 10;
  const warehouseId = await makeWarehouse();
  const productId = await makeProduct();
  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  await applyStockChange(db, {
    productId,
    warehouseId,
    delta: stock,
    type: 'received',
    reason: 'Test receipt',
  });

  const orderId = generateId('ord');
  await db.insert(schema.orders).values({
    id: orderId,
    orderNumber: `SO-${orderId.slice(-8).toUpperCase()}`,
    status: 'confirmed',
    fulfillmentStatus: 'unfulfilled',
    subtotal: '10.00',
    total: '10.00',
  });
  await db.insert(schema.orderItems).values({
    id: generateId('oi'),
    orderId,
    productId,
    sku: product!.sku,
    name: product!.name,
    quantity,
    unitPrice: '10.00',
    total: '30.00',
    fulfilledQuantity: 0,
    requiresShipping: 1,
  });

  return {
    warehouseId,
    productId,
    orderId,
    sku: product!.sku!,
    barcode: product!.barcode!,
  };
}

function mockSendcloud(overrides: Partial<SendcloudClient> = {}): SendcloudClient {
  return {
    listSenderAddresses: async () => [],
    listShippingOptions: async () => [],
    announceShipment: async () => ({
      id: 'shp_sc_1',
      carrierCode: 'postnl',
      carrierName: 'PostNL',
      shippingOptionCode: 'postnl:standard',
      errors: [],
      parcel: {
        id: 383707309,
        trackingNumber: '3SYZXG8498635',
        trackingUrl: 'https://tracking.sendcloud.sc/3SYZXG8498635',
        labelPdfBase64: 'JVBERi0x',
        labelDocumentUrl: 'https://panel.sendcloud.sc/api/v3/parcels/383707309/documents/label',
        statusCode: 'READY_TO_SEND',
      },
    }),
    getParcelDocument: async () => ({ bytes: new ArrayBuffer(8), contentType: 'application/pdf' }),
    ...overrides,
  };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('generatePickList', () => {
  it('allocates available stock and marks the order as picking', async () => {
    const seed = await seedShippableOrder({ quantity: 4, stock: 10 });
    const result = await generatePickList(db, {
      orderId: seed.orderId,
      warehouseId: seed.warehouseId,
    });

    expect(result.status).toBe('pending');
    expect(result.itemCount).toBe(1);

    const detail = await getPickListWithItems(db, result.id);
    expect(detail?.items[0]?.quantityRequired).toBe(4);
    expect(detail?.items[0]?.status).toBe('pending');

    const bucket = await bucketFor(seed.productId, seed.warehouseId);
    expect(bucket?.quantityOnHand).toBe(10);
    expect(bucket?.quantityAllocated).toBe(4);
    expect(bucket?.quantityAvailable).toBe(6);

    const [order] = await db
      .select({ fulfillmentStatus: schema.orders.fulfillmentStatus })
      .from(schema.orders)
      .where(eq(schema.orders.id, seed.orderId))
      .limit(1);
    expect(order?.fulfillmentStatus).toBe('picking');
  });

  it('rejects a second open pick list for the same order', async () => {
    const seed = await seedShippableOrder();
    await generatePickList(db, { orderId: seed.orderId, warehouseId: seed.warehouseId });
    await expect(
      generatePickList(db, { orderId: seed.orderId, warehouseId: seed.warehouseId }),
    ).rejects.toMatchObject({ code: 'ALREADY_PICKING' });
  });

  it('rejects when available stock cannot cover the order', async () => {
    const seed = await seedShippableOrder({ quantity: 5, stock: 2 });
    await expect(
      generatePickList(db, { orderId: seed.orderId, warehouseId: seed.warehouseId }),
    ).rejects.toMatchObject({ code: 'NO_SHIPPABLE_ITEMS' });
  });
});

describe('pick → pack → ship', () => {
  it('confirms a scanned line, then packs and ships through the ledger', async () => {
    const seed = await seedShippableOrder({ quantity: 3, stock: 10 });
    const generated = await generatePickList(db, {
      orderId: seed.orderId,
      warehouseId: seed.warehouseId,
      assignedTo: 'user_picker',
    });
    expect(generated.status).toBe('assigned');

    await startPickList(db, generated.id);
    const detail = await getPickListWithItems(db, generated.id);
    const item = detail!.items[0]!;

    await expect(
      confirmPickItem(db, {
        pickListId: generated.id,
        itemId: item.id,
        quantity: 3,
        productBarcode: 'WRONG',
      }),
    ).rejects.toMatchObject({ code: 'SCAN_MISMATCH' });

    const picked = await confirmPickItem(db, {
      pickListId: generated.id,
      itemId: item.id,
      quantity: 3,
      productBarcode: seed.barcode,
    });
    expect(picked?.status).toBe('picked');
    expect(picked?.quantityPicked).toBe(3);

    const completed = await completePickList(db, generated.id, 'user_picker');
    expect(completed?.status).toBe('completed');

    const packed = await packPickList(db, generated.id, 'user_packer');
    expect(packed?.status).toBe('packed');
    expect(packed?.parcelId).toBeTruthy();

    const shipped = await shipPickList(db, generated.id, 'user_shipper', {
      senderId: 12,
      shippingOptionCode: 'postnl:standard',
      weightKg: 1,
      sendcloud: mockSendcloud(),
    });
    expect(shipped?.status).toBe('shipped');
    expect(shipped?.shipmentId).toBeTruthy();

    const bucket = await bucketFor(seed.productId, seed.warehouseId);
    expect(bucket?.quantityOnHand).toBe(7);
    expect(bucket?.quantityAllocated).toBe(0);
    expect(bucket?.quantityAvailable).toBe(7);

    const [order] = await db
      .select({ fulfillmentStatus: schema.orders.fulfillmentStatus })
      .from(schema.orders)
      .where(eq(schema.orders.id, seed.orderId))
      .limit(1);
    expect(order?.fulfillmentStatus).toBe('fulfilled');

    const [line] = await db
      .select({ fulfilledQuantity: schema.orderItems.fulfilledQuantity })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, seed.orderId))
      .limit(1);
    expect(line?.fulfilledQuantity).toBe(3);
  });

  it('releases the short remainder and still ships the picked qty', async () => {
    const seed = await seedShippableOrder({ quantity: 4, stock: 10 });
    const generated = await generatePickList(db, {
      orderId: seed.orderId,
      warehouseId: seed.warehouseId,
    });
    const detail = await getPickListWithItems(db, generated.id);
    const item = detail!.items[0]!;

    const picked = await confirmPickItem(db, {
      pickListId: generated.id,
      itemId: item.id,
      quantity: 1,
      productBarcode: seed.sku,
      short: true,
    });
    expect(picked?.status).toBe('partial');
    expect(picked?.quantityShort).toBe(3);

    const afterShort = await bucketFor(seed.productId, seed.warehouseId);
    expect(afterShort?.quantityAllocated).toBe(1);
    expect(afterShort?.quantityOnHand).toBe(10);

    await completePickList(db, generated.id);
    await packPickList(db, generated.id);
    await shipPickList(db, generated.id, 'user_shipper', {
      senderId: 12,
      shippingOptionCode: 'postnl:standard',
      weightKg: 1,
      sendcloud: mockSendcloud(),
    });

    const afterShip = await bucketFor(seed.productId, seed.warehouseId);
    expect(afterShip?.quantityOnHand).toBe(9);
    expect(afterShip?.quantityAllocated).toBe(0);

    const [order] = await db
      .select({ fulfillmentStatus: schema.orders.fulfillmentStatus })
      .from(schema.orders)
      .where(eq(schema.orders.id, seed.orderId))
      .limit(1);
    expect(order?.fulfillmentStatus).toBe('partial');
  });

  it('rejects a second pick on a finished line without releasing more allocation', async () => {
    const seed = await seedShippableOrder({ quantity: 3, stock: 10 });
    const generated = await generatePickList(db, {
      orderId: seed.orderId,
      warehouseId: seed.warehouseId,
    });
    const detail = await getPickListWithItems(db, generated.id);
    const item = detail!.items[0]!;

    await confirmPickItem(db, {
      pickListId: generated.id,
      itemId: item.id,
      quantity: 3,
      productBarcode: seed.barcode,
    });
    const afterPick = await bucketFor(seed.productId, seed.warehouseId);
    expect(afterPick?.quantityAllocated).toBe(3);

    await expect(
      confirmPickItem(db, {
        pickListId: generated.id,
        itemId: item.id,
        quantity: 0,
        productBarcode: seed.barcode,
        short: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const afterRetry = await bucketFor(seed.productId, seed.warehouseId);
    expect(afterRetry?.quantityAllocated).toBe(3);
    expect(afterRetry?.quantityOnHand).toBe(10);
  });
});

describe('PATCH /api/pick-lists/:id', () => {
  it('does not let a status patch skip pack/ship', async () => {
    const seed = await seedShippableOrder({ quantity: 1, stock: 5 });
    const generated = await generatePickList(db, {
      orderId: seed.orderId,
      warehouseId: seed.warehouseId,
    });

    const { request } = createTestApp('/api/pick-lists', pickListsRoutes, {
      context: { permissions: permissions('picklists:update'), tenantDb: db },
    });
    const res = await request(`/api/pick-lists/${generated.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'shipped', parcelId: 'par_fake' }),
    });
    expect(res.status).toBe(200);

    const detail = await getPickListWithItems(db, generated.id);
    expect(detail?.status).toBe('pending');
    expect(detail?.parcelId).toBeNull();

    const bucket = await bucketFor(seed.productId, seed.warehouseId);
    expect(bucket?.quantityOnHand).toBe(5);
    expect(bucket?.quantityAllocated).toBe(1);
  });
});

describe('cancelPickList', () => {
  it('releases remaining allocation', async () => {
    const seed = await seedShippableOrder({ quantity: 2, stock: 8 });
    const generated = await generatePickList(db, {
      orderId: seed.orderId,
      warehouseId: seed.warehouseId,
    });
    await cancelPickList(db, generated.id);

    const bucket = await bucketFor(seed.productId, seed.warehouseId);
    expect(bucket?.quantityAllocated).toBe(0);
    expect(bucket?.quantityOnHand).toBe(8);

    const cancelled = await getPickListWithItems(db, generated.id);
    expect(cancelled?.status).toBe('cancelled');
  });
});

describe('assignPickList', () => {
  it('moves pending lists to assigned', async () => {
    const seed = await seedShippableOrder();
    const generated = await generatePickList(db, {
      orderId: seed.orderId,
      warehouseId: seed.warehouseId,
    });
    const assigned = await assignPickList(db, {
      id: generated.id,
      assignedTo: 'user_1',
      assignedToName: 'Ada',
    });
    expect(assigned?.status).toBe('assigned');
  });
});

describe('renderPackingSlipHtml', () => {
  it('includes picked lines and escapes HTML', async () => {
    const html = renderPackingSlipHtml({
      pickListNumber: 'PL-1',
      orderNumber: 'SO-99',
      warehouseName: 'Main',
      packedAt: new Date('2026-08-18T12:00:00.000Z'),
      items: [
        { sku: 'A<script>', name: 'Widget', quantityPicked: 2, locationCode: 'A-1' },
        { sku: 'B', name: 'Skip me', quantityPicked: 0 },
      ],
    });
    expect(html).toContain('PL-1');
    expect(html).toContain('SO-99');
    expect(html).toContain('A-1');
    expect(html).toContain('A&lt;script&gt;');
    expect(html).not.toContain('Skip me');
  });
});

async function packReadyList(params?: { requiresShipping?: number; address?: boolean }) {
  const seed = await seedShippableOrder({ quantity: 2, stock: 5 });
  await db
    .update(schema.orders)
    .set({
      customerName: 'Ada Lovelace',
      customerEmail: 'ada@example.com',
      shippingAddress: params?.address === false
        ? null
        : {
            name: 'Ada Lovelace',
            line1: 'Insulindelaan 115',
            city: 'Eindhoven',
            postalCode: '5642CV',
            country: 'NL',
            phone: '+31612345678',
          },
    })
    .where(eq(schema.orders.id, seed.orderId));
  await db
    .update(schema.orderItems)
    .set({ requiresShipping: params?.requiresShipping ?? 1 })
    .where(eq(schema.orderItems.orderId, seed.orderId));
  const generated = await generatePickList(db, {
    orderId: seed.orderId,
    warehouseId: seed.warehouseId,
  });
  const detail = await getPickListWithItems(db, generated.id);
  const item = detail!.items[0]!;
  await confirmPickItem(db, {
    pickListId: generated.id,
    itemId: item.id,
    quantity: 2,
    productBarcode: seed.sku,
  });
  await completePickList(db, generated.id);
  await packPickList(db, generated.id);
  return { ...seed, pickListId: generated.id };
}

describe('shipPickList Sendcloud', () => {
  it('refuses to ship a physical order without a connected Sendcloud account', async () => {
    const ready = await packReadyList();
    await expect(shipPickList(db, ready.pickListId, 'user_shipper')).rejects.toMatchObject({
      code: 'SHIPPING_NOT_CONFIGURED',
    });
    const detail = await getPickListWithItems(db, ready.pickListId);
    expect(detail?.status).toBe('packed');
    const bucket = await bucketFor(ready.productId, ready.warehouseId);
    expect(bucket?.quantityAllocated).toBe(2);
    expect(bucket?.quantityOnHand).toBe(5);
  });

  it('announces via Sendcloud then fulfills stock and writes tracking', async () => {
    const ready = await packReadyList();
    const shipped = await shipPickList(db, ready.pickListId, 'user_shipper', {
      senderId: 12,
      shippingOptionCode: 'postnl:standard',
      weightKg: 1.25,
      sendcloud: mockSendcloud(),
    });
    expect(shipped?.status).toBe('shipped');
    expect(shipped?.trackingNumber).toBe('3SYZXG8498635');
    expect(shipped?.labelPdfBase64).toBe('JVBERi0x');

    const [order] = await db
      .select({
        fulfillmentStatus: schema.orders.fulfillmentStatus,
        trackingNumber: schema.orders.trackingNumber,
        shippingCarrier: schema.orders.shippingCarrier,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, ready.orderId))
      .limit(1);
    expect(order?.fulfillmentStatus).toBe('fulfilled');
    expect(order?.trackingNumber).toBe('3SYZXG8498635');
    expect(order?.shippingCarrier).toBe('PostNL');

    const bucket = await bucketFor(ready.productId, ready.warehouseId);
    expect(bucket?.quantityOnHand).toBe(3);
    expect(bucket?.quantityAllocated).toBe(0);
  });

  it('leaves the pick list packed when Sendcloud rejects the announcement', async () => {
    const ready = await packReadyList();
    await expect(
      shipPickList(db, ready.pickListId, 'user_shipper', {
        senderId: 12,
        shippingOptionCode: 'postnl:standard',
        weightKg: 1,
        sendcloud: mockSendcloud({
          announceShipment: async () => {
            throw new SendcloudError('carrier rejected', 400, 'VALIDATION');
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'SENDCLOUD_FAILED' });

    const detail = await getPickListWithItems(db, ready.pickListId);
    expect(detail?.status).toBe('packed');
    const bucket = await bucketFor(ready.productId, ready.warehouseId);
    expect(bucket?.quantityAllocated).toBe(2);
    expect(bucket?.quantityOnHand).toBe(5);
  });
});

