/**
 * Rows the stash route tests seed on pglite: warehouses, products, stock and
 * orders, written straight to the tenant database (not through the routes).
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { applyStockChange } from '../services/inventory-ledger';

export async function makeWarehouse(db: Database, overrides: Partial<typeof schema.warehouses.$inferInsert> = {}): Promise<string> {
  const id = overrides.id ?? generateId('wh');
  await db.insert(schema.warehouses).values({
    id,
    name: `Warehouse ${id}`,
    code: id.slice(0, 12),
    isDefault: false,
    isActive: true,
    ...overrides,
  });
  return id;
}

export async function makeProduct(db: Database, overrides: Partial<typeof schema.products.$inferInsert> = {}): Promise<string> {
  const id = overrides.id ?? generateId('prod');
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

export async function makeLocation(
  db: Database,
  warehouseId: string,
  overrides: Partial<typeof schema.warehouseLocations.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? generateId('loc');
  await db.insert(schema.warehouseLocations).values({
    id,
    warehouseId,
    name: `Location ${id}`,
    code: `L-${id.slice(-6).toUpperCase()}`,
    barcode: `LB-${id.slice(-6).toUpperCase()}`,
    ...overrides,
  });
  return id;
}

/** Receive `quantity` units through the ledger, as a receipt would. */
export async function receive(
  db: Database,
  params: { productId: string; warehouseId: string; quantity: number; locationId?: string | null; lotNumber?: string | null },
): Promise<string> {
  const result = await applyStockChange(db, {
    productId: params.productId,
    warehouseId: params.warehouseId,
    locationId: params.locationId ?? null,
    lotNumber: params.lotNumber ?? null,
    delta: params.quantity,
    type: 'received',
    reason: 'Test receipt',
  });
  return result.inventoryId;
}

export interface SeededOrder {
  warehouseId: string;
  productId: string;
  orderId: string;
  orderItemId: string;
  sku: string;
  barcode: string;
}

/** A warehouse, a product with stock, and an unfulfilled order for it. */
export async function seedShippableOrder(
  db: Database,
  params: {
    quantity?: number;
    stock?: number;
    requiresShipping?: number;
    shippingAddress?: Record<string, unknown> | null;
    warehouseId?: string;
    locationId?: string;
  } = {},
): Promise<SeededOrder> {
  const quantity = params.quantity ?? 3;
  const stock = params.stock ?? 10;
  const warehouseId = params.warehouseId ?? (await makeWarehouse(db));
  const productId = await makeProduct(db);
  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  if (stock > 0) {
    await receive(db, { productId, warehouseId, quantity: stock, locationId: params.locationId ?? null });
  }

  const orderId = generateId('ord');
  await db.insert(schema.orders).values({
    id: orderId,
    orderNumber: `SO-${orderId.slice(-8).toUpperCase()}`,
    status: 'confirmed',
    fulfillmentStatus: 'unfulfilled',
    subtotal: '10.00',
    total: '10.00',
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.com',
    customerPhone: '+31600000000',
    shippingAddress:
      params.shippingAddress === undefined
        ? {
            name: 'Ada Lovelace',
            line1: 'Insulindelaan 115',
            city: 'Eindhoven',
            postalCode: '5642CV',
            country: 'NL',
            phone: '+31612345678',
          }
        : (params.shippingAddress as never),
  });
  const orderItemId = generateId('oi');
  await db.insert(schema.orderItems).values({
    id: orderItemId,
    orderId,
    productId,
    sku: product!.sku,
    name: product!.name,
    quantity,
    unitPrice: '10.00',
    total: '30.00',
    fulfilledQuantity: 0,
    requiresShipping: params.requiresShipping ?? 1,
  });

  return { warehouseId, productId, orderId, orderItemId, sku: product!.sku!, barcode: product!.barcode! };
}
