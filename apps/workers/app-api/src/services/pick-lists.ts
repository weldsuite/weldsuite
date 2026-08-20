/**
 * Pick-list orchestration — generate from unfulfilled orders, scan-confirm
 * lines, pack, and ship through the inventory ledger.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';
import { generateId } from '../lib/id';
import {
  allocateStock,
  issueAllocatedStock,
  releaseAllocation,
  StockLedgerError,
} from './inventory-ledger';
import type { EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { SendcloudClient } from './sendcloud/client';
import { SendcloudError, createSendcloudClient } from './sendcloud/client';
import { toSendcloudToAddress } from './sendcloud/addresses';
import {
  decryptSecret,
  getSendcloudSettings,
} from './sendcloud/settings';

const {
  pickLists,
  pickListItems,
  orders,
  orderItems,
  products,
  productVariants,
  inventory,
  warehouseLocations,
  warehouses,
  activityLogs,
  parcels,
  shipments,
} = schema;

const OPEN_STATUSES = ['pending', 'assigned', 'in_progress', 'completed', 'packed'] as const;
const TERMINAL_ITEM = new Set(['picked', 'partial', 'short', 'skipped']);

export class PickListError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'ORDER_NOT_FOUND'
      | 'WAREHOUSE_NOT_FOUND'
      | 'NO_SHIPPABLE_ITEMS'
      | 'ALREADY_PICKING'
      | 'INVALID_STATUS'
      | 'SCAN_MISMATCH'
      | 'ITEM_NOT_FOUND'
      | 'INCOMPLETE_LINES'
      | 'SHIPPING_NOT_CONFIGURED'
      | 'MISSING_ADDRESS'
      | 'SENDCLOUD_FAILED',
  ) {
    super(message);
    this.name = 'PickListError';
  }
}

function normalizeScan(value: string): string {
  return value.trim().toLowerCase();
}

/** Order items own `requires_shipping`; the orders table has no such column. */
function lineRequiresCarrier(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const n = Number(value ?? 1);
  return Number.isFinite(n) ? n !== 0 : true;
}

export async function orderRequiresCarrier(db: Database, orderId: string | null): Promise<boolean> {
  if (!orderId) return true;
  const lines = await db
    .select({ requiresShipping: orderItems.requiresShipping })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (lines.length === 0) return true;
  return lines.some((line) => lineRequiresCarrier(line.requiresShipping));
}

async function writeActivity(
  db: Database,
  params: {
    activityType: 'pick' | 'pack' | 'ship';
    entityId: string;
    userId?: string | null;
    warehouseId?: string | null;
    description: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(activityLogs).values({
    id: generateId('act'),
    activityType: params.activityType,
    entityType: 'pick_list',
    entityId: params.entityId,
    userId: params.userId ?? null,
    warehouseId: params.warehouseId ?? null,
    description: params.description,
    metadata: params.metadata ?? null,
    createdAt: new Date(),
  });
}

async function loadPickList(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(pickLists)
    .where(and(eq(pickLists.id, id), isNull(pickLists.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function loadItems(db: Database, pickListId: string) {
  return db
    .select()
    .from(pickListItems)
    .where(eq(pickListItems.pickListId, pickListId))
    .orderBy(asc(pickListItems.pickSequence), asc(pickListItems.createdAt));
}

async function suggestBucket(
  db: Database,
  params: { productId: string; warehouseId: string; variantId?: string | null; quantity: number },
) {
  const conditions = [
    eq(inventory.productId, params.productId),
    eq(inventory.warehouseId, params.warehouseId),
    isNull(inventory.deletedAt),
    sql`${inventory.quantityOnHand} - COALESCE(${inventory.quantityAllocated}, 0) >= ${params.quantity}`,
  ];
  if (params.variantId) conditions.push(eq(inventory.variantId, params.variantId));
  else conditions.push(isNull(inventory.variantId));

  const [row] = await db
    .select({
      inventoryId: inventory.id,
      locationId: inventory.locationId,
      locationCode: warehouseLocations.code,
      lotNumber: inventory.lotNumber,
      batchNumber: inventory.batchNumber,
      expiryDate: inventory.expiryDate,
      pickingSequence: warehouseLocations.pickingSequence,
      isPrimaryPick: warehouseLocations.isPrimaryPick,
    })
    .from(inventory)
    .leftJoin(warehouseLocations, eq(inventory.locationId, warehouseLocations.id))
    .where(and(...conditions))
    .orderBy(
      sql`CASE WHEN ${warehouseLocations.isPrimaryPick} = true THEN 0 ELSE 1 END`,
      sql`${warehouseLocations.pickingSequence} ASC NULLS LAST`,
    )
    .limit(1);

  return row ?? null;
}

export async function generatePickList(
  db: Database,
  params: {
    orderId: string;
    warehouseId?: string;
    assignedTo?: string;
    assignedToName?: string;
    priority?: string;
    createdBy?: string;
  },
) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, params.orderId), isNull(orders.deletedAt)))
    .limit(1);
  if (!order) throw new PickListError(`Order ${params.orderId} not found`, 'ORDER_NOT_FOUND');
  if (order.fulfillmentStatus === 'fulfilled') {
    throw new PickListError('Order is already fulfilled', 'ALREADY_PICKING');
  }

  let warehouseId = params.warehouseId;
  if (!warehouseId) {
    const [def] = await db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.isDefault, true), isNull(warehouses.deletedAt)))
      .limit(1);
    warehouseId = def?.id;
  }
  if (!warehouseId) {
    const [any] = await db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(isNull(warehouses.deletedAt))
      .limit(1);
    warehouseId = any?.id;
  }
  if (!warehouseId) throw new PickListError('No warehouse available', 'WAREHOUSE_NOT_FOUND');

  const [wh] = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId), isNull(warehouses.deletedAt)))
    .limit(1);
  if (!wh) throw new PickListError(`Warehouse ${warehouseId} not found`, 'WAREHOUSE_NOT_FOUND');

  const existing = await db
    .select({ id: pickLists.id, status: pickLists.status })
    .from(pickLists)
    .where(
      and(
        isNull(pickLists.deletedAt),
        inArray(pickLists.status, [...OPEN_STATUSES]),
        sql`${pickLists.orderIds} @> ${JSON.stringify([params.orderId])}::jsonb`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new PickListError(
      `Order already has an open pick list (${existing[0].id})`,
      'ALREADY_PICKING',
    );
  }

  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, params.orderId));
  const shippable = lines.filter((line) => {
    if (!line.productId) return false;
    if (!lineRequiresCarrier(line.requiresShipping)) return false;
    const remaining = (line.quantity ?? 0) - (line.fulfilledQuantity ?? 0);
    return remaining > 0;
  });
  if (shippable.length === 0) {
    throw new PickListError('Order has no remaining shippable items', 'NO_SHIPPABLE_ITEMS');
  }

  const now = new Date();
  const pickListId = generateId('pl');
  const pickListNumber = `PL-${Date.now().toString(36).toUpperCase()}`;
  const status = params.assignedTo ? 'assigned' : 'pending';

  const itemRows: (typeof pickListItems.$inferInsert)[] = [];
  let sequence = 0;
  let totalQuantity = 0;

  for (const line of shippable) {
    const remaining = (line.quantity ?? 0) - (line.fulfilledQuantity ?? 0);
    const bucket = await suggestBucket(db, {
      productId: line.productId!,
      warehouseId,
      variantId: line.variantId,
      quantity: remaining,
    });
    if (!bucket) {
      throw new PickListError(
        `Insufficient available stock for ${line.sku || line.name}`,
        'NO_SHIPPABLE_ITEMS',
      );
    }

    sequence += 1;
    totalQuantity += remaining;
    itemRows.push({
      id: generateId('pli'),
      pickListId,
      orderId: params.orderId,
      orderItemId: line.id,
      productId: line.productId!,
      variantId: line.variantId ?? null,
      sku: line.sku ?? null,
      name: line.name,
      locationId: bucket.locationId ?? null,
      locationCode: bucket.locationCode ?? null,
      inventoryId: bucket.inventoryId,
      quantityRequired: remaining,
      quantityPicked: 0,
      quantityShort: 0,
      lotNumber: bucket.lotNumber ?? null,
      batchNumber: bucket.batchNumber ?? null,
      expiryDate: bucket.expiryDate ?? null,
      status: 'pending',
      pickSequence: bucket.pickingSequence ?? sequence,
      createdAt: now,
      updatedAt: now,
    });
  }

  itemRows.sort((a, b) => (a.pickSequence ?? 0) - (b.pickSequence ?? 0));
  itemRows.forEach((row, i) => {
    row.pickSequence = i + 1;
  });

  await db.insert(pickLists).values({
    id: pickListId,
    pickListNumber,
    warehouseId,
    status,
    priority: params.priority ?? 'normal',
    assignedTo: params.assignedTo ?? null,
    assignedToName: params.assignedToName ?? null,
    assignedAt: params.assignedTo ? now : null,
    totalItems: itemRows.length,
    pickedItems: 0,
    totalQuantity,
    pickedQuantity: 0,
    orderIds: [params.orderId],
    orderCount: 1,
    pickType: 'order',
    createdBy: params.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(pickListItems).values(itemRows);

  for (const row of itemRows) {
    if (row.inventoryId && row.quantityRequired) {
      await allocateStock(db, { inventoryId: row.inventoryId, quantity: row.quantityRequired });
    }
  }

  if (order.fulfillmentStatus === 'unfulfilled') {
    await db
      .update(orders)
      .set({ fulfillmentStatus: 'picking', updatedAt: now })
      .where(eq(orders.id, params.orderId));
  }

  return { id: pickListId, pickListNumber, status, itemCount: itemRows.length };
}

export async function getPickListWithItems(db: Database, id: string) {
  const row = await loadPickList(db, id);
  if (!row) return null;
  const items = await loadItems(db, id);
  return { ...row, items };
}

export async function assignPickList(
  db: Database,
  params: { id: string; assignedTo: string | null; assignedToName: string | null },
) {
  const row = await loadPickList(db, params.id);
  if (!row) return null;
  if (!['pending', 'assigned'].includes(row.status)) {
    throw new PickListError(`Cannot assign a pick list in status ${row.status}`, 'INVALID_STATUS');
  }
  const now = new Date();
  const nextStatus = params.assignedTo ? 'assigned' : 'pending';
  await db
    .update(pickLists)
    .set({
      assignedTo: params.assignedTo,
      assignedToName: params.assignedToName,
      assignedAt: params.assignedTo ? now : null,
      status: nextStatus,
      updatedAt: now,
    })
    .where(eq(pickLists.id, params.id));
  return { id: params.id, status: nextStatus };
}

export async function startPickList(db: Database, id: string) {
  const row = await loadPickList(db, id);
  if (!row) return null;
  if (!['pending', 'assigned', 'in_progress'].includes(row.status)) {
    throw new PickListError(`Cannot start a pick list in status ${row.status}`, 'INVALID_STATUS');
  }
  if (row.status === 'in_progress') return { id, status: row.status };
  const now = new Date();
  await db
    .update(pickLists)
    .set({ status: 'in_progress', startedAt: row.startedAt ?? now, updatedAt: now })
    .where(eq(pickLists.id, id));
  return { id, status: 'in_progress' };
}

async function barcodesForItem(
  db: Database,
  item: typeof pickListItems.$inferSelect,
): Promise<{ location: string[]; product: string[] }> {
  const location: string[] = [];
  if (item.locationCode) location.push(normalizeScan(item.locationCode));
  if (item.locationId) {
    const [loc] = await db
      .select({ barcode: warehouseLocations.barcode, code: warehouseLocations.code })
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, item.locationId))
      .limit(1);
    if (loc?.barcode) location.push(normalizeScan(loc.barcode));
    if (loc?.code) location.push(normalizeScan(loc.code));
  }

  const product: string[] = [];
  if (item.sku) product.push(normalizeScan(item.sku));
  const [prod] = await db
    .select({ barcode: products.barcode, sku: products.sku })
    .from(products)
    .where(eq(products.id, item.productId))
    .limit(1);
  if (prod?.barcode) product.push(normalizeScan(prod.barcode));
  if (prod?.sku) product.push(normalizeScan(prod.sku));
  if (item.variantId) {
    const [variant] = await db
      .select({ barcode: productVariants.barcode, sku: productVariants.sku })
      .from(productVariants)
      .where(eq(productVariants.id, item.variantId))
      .limit(1);
    if (variant?.barcode) product.push(normalizeScan(variant.barcode));
    if (variant?.sku) product.push(normalizeScan(variant.sku));
  }
  return { location, product };
}

export async function confirmPickItem(
  db: Database,
  params: {
    pickListId: string;
    itemId: string;
    quantity: number;
    productBarcode: string;
    locationBarcode?: string;
    short?: boolean;
    userId?: string;
  },
) {
  const list = await loadPickList(db, params.pickListId);
  if (!list) return null;
  if (!['pending', 'assigned', 'in_progress'].includes(list.status)) {
    throw new PickListError(`Cannot pick a list in status ${list.status}`, 'INVALID_STATUS');
  }

  const [item] = await db
    .select()
    .from(pickListItems)
    .where(and(eq(pickListItems.id, params.itemId), eq(pickListItems.pickListId, params.pickListId)))
    .limit(1);
  if (!item) throw new PickListError('Pick list item not found', 'ITEM_NOT_FOUND');
  if (TERMINAL_ITEM.has(item.status ?? '')) {
    throw new PickListError(
      `Cannot pick a line in status ${item.status}`,
      'INVALID_STATUS',
    );
  }

  const expected = await barcodesForItem(db, item);
  const scannedProduct = normalizeScan(params.productBarcode);
  if (!expected.product.includes(scannedProduct)) {
    throw new PickListError('Scanned product does not match this pick line', 'SCAN_MISMATCH');
  }
  if (item.locationId) {
    const scannedLocation = params.locationBarcode ? normalizeScan(params.locationBarcode) : '';
    if (!scannedLocation || !expected.location.includes(scannedLocation)) {
      throw new PickListError('Scanned location does not match this pick line', 'SCAN_MISMATCH');
    }
  }

  const required = item.quantityRequired ?? 0;
  const qty = Math.min(params.quantity, required);
  const isShort = params.short || qty < required;
  const now = new Date();
  const nextStatus = qty <= 0 ? 'short' : isShort ? (qty > 0 ? 'partial' : 'short') : 'picked';
  const quantityShort = Math.max(required - qty, 0);

  await db
    .update(pickListItems)
    .set({
      quantityPicked: qty,
      quantityShort,
      status: nextStatus,
      pickedAt: now,
      pickedBy: params.userId ?? null,
      updatedAt: now,
    })
    .where(eq(pickListItems.id, item.id));

  if (item.inventoryId && quantityShort > 0) {
    await releaseAllocation(db, { inventoryId: item.inventoryId, quantity: quantityShort });
  }

  if (list.status !== 'in_progress') {
    await db
      .update(pickLists)
      .set({ status: 'in_progress', startedAt: list.startedAt ?? now, updatedAt: now })
      .where(eq(pickLists.id, list.id));
  }

  const items = await loadItems(db, list.id);
  const pickedItems = items.filter((i) => TERMINAL_ITEM.has(i.status ?? '')).length;
  const pickedQuantity = items.reduce((sum, i) => sum + (i.quantityPicked ?? 0), 0);
  await db
    .update(pickLists)
    .set({ pickedItems, pickedQuantity, updatedAt: now })
    .where(eq(pickLists.id, list.id));

  await writeActivity(db, {
    activityType: 'pick',
    entityId: list.id,
    userId: params.userId,
    warehouseId: list.warehouseId,
    description: `Picked ${qty}/${required} of ${item.sku || item.name}`,
    metadata: { itemId: item.id, status: nextStatus },
  });

  return { id: item.id, status: nextStatus, quantityPicked: qty, quantityShort };
}

export async function completePickList(db: Database, id: string, userId?: string) {
  const list = await loadPickList(db, id);
  if (!list) return null;
  if (!['pending', 'assigned', 'in_progress'].includes(list.status)) {
    throw new PickListError(`Cannot complete a pick list in status ${list.status}`, 'INVALID_STATUS');
  }
  const items = await loadItems(db, id);
  const unfinished = items.filter((i) => !TERMINAL_ITEM.has(i.status ?? ''));
  if (unfinished.length > 0) {
    throw new PickListError(
      `${unfinished.length} line(s) still pending — pick, short, or skip them first`,
      'INCOMPLETE_LINES',
    );
  }
  const now = new Date();
  await db
    .update(pickLists)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(eq(pickLists.id, id));
  await writeActivity(db, {
    activityType: 'pick',
    entityId: id,
    userId,
    warehouseId: list.warehouseId,
    description: `Completed pick list ${list.pickListNumber}`,
  });
  return { id, status: 'completed' };
}

export async function packPickList(db: Database, id: string, userId?: string) {
  const list = await loadPickList(db, id);
  if (!list) return null;
  if (list.status === 'packed' && list.parcelId) {
    return { id, status: 'packed', parcelId: list.parcelId };
  }
  if (list.status !== 'completed') {
    throw new PickListError(`Cannot pack a pick list in status ${list.status}`, 'INVALID_STATUS');
  }

  const orderId = list.orderIds?.[0] ?? null;
  let orderNumber: string | null = null;
  let recipientName: string | null = null;
  let recipientEmail: string | null = null;
  let recipientPhone: string | null = null;
  let recipientAddress: typeof parcels.$inferInsert.recipientAddress = null;
  if (orderId) {
    const [order] = await db
      .select({
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        customerPhone: orders.customerPhone,
        shippingAddress: orders.shippingAddress,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    orderNumber = order?.orderNumber ?? null;
    const shipping = order?.shippingAddress ?? null;
    recipientName = shipping?.name || order?.customerName || null;
    recipientEmail = order?.customerEmail ?? null;
    recipientPhone = shipping?.phone || order?.customerPhone || null;
    if (shipping) {
      recipientAddress = {
        line1: shipping.line1 ?? '',
        line2: shipping.line2,
        city: shipping.city ?? '',
        state: shipping.state,
        postalCode: shipping.postalCode ?? '',
        country: shipping.country ?? '',
      };
    }
  }

  const now = new Date();
  const parcelId = generateId('par');
  await db.insert(parcels).values({
    id: parcelId,
    status: 'draft',
    orderId,
    orderNumber,
    referenceNumber: list.pickListNumber,
    contents: `Pick list ${list.pickListNumber}`,
    recipientName,
    recipientEmail,
    recipientPhone,
    recipientAddress,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(pickLists)
    .set({
      status: 'packed',
      packedAt: now,
      packedBy: userId ?? null,
      parcelId,
      updatedAt: now,
    })
    .where(eq(pickLists.id, id));
  await writeActivity(db, {
    activityType: 'pack',
    entityId: id,
    userId,
    warehouseId: list.warehouseId,
    description: `Packed pick list ${list.pickListNumber}`,
    metadata: { parcelId },
  });
  return { id, status: 'packed', parcelId };
}

export interface ShipPickListOptions {
  senderId?: number;
  shippingOptionCode?: string;
  weightKg?: number;
  sendcloud?: SendcloudClient;
  keyring?: EncryptionKeyring;
  workspaceId?: string;
}

export interface ShipPickListResult {
  id: string;
  status: string;
  shipmentId?: string | null;
  parcelId?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  labelUrl?: string | null;
  labelPdfBase64?: string | null;
  carrierName?: string | null;
  shippingOptionCode?: string | null;
}

export async function shipPickList(
  db: Database,
  id: string,
  userId?: string,
  options: ShipPickListOptions = {},
): Promise<ShipPickListResult | null> {
  const list = await loadPickList(db, id);
  if (!list) return null;
  if (list.status === 'shipped') {
    return { id, status: 'shipped', shipmentId: list.shipmentId, parcelId: list.parcelId };
  }
  if (list.status !== 'packed') {
    throw new PickListError(`Cannot ship a pick list in status ${list.status}`, 'INVALID_STATUS');
  }

  const orderId = list.orderIds?.[0] ?? null;
  const [order] = orderId
    ? await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
    : [undefined];
  const requiresShipping = await orderRequiresCarrier(db, orderId);

  let trackingNumber: string | null = null;
  let trackingUrl: string | null = null;
  let labelUrl: string | null = null;
  let labelPdfBase64: string | null = null;
  let carrierName: string | null = null;
  let shippingOptionCode: string | null = options.shippingOptionCode ?? null;
  let sendcloudParcelId: number | null = null;
  let sendcloudShipmentId: string | number | null = null;

  if (requiresShipping) {
    const announced = await announceSendcloudParcel(db, {
      list,
      order,
      options,
    });
    trackingNumber = announced.trackingNumber;
    trackingUrl = announced.trackingUrl;
    labelUrl = announced.labelUrl;
    labelPdfBase64 = announced.labelPdfBase64;
    carrierName = announced.carrierName;
    shippingOptionCode = announced.shippingOptionCode;
    sendcloudParcelId = announced.sendcloudParcelId;
    sendcloudShipmentId = announced.sendcloudShipmentId;
  }

  const items = await loadItems(db, id);
  const now = new Date();
  const shipmentId = list.shipmentId ?? generateId('shp');
  const shipmentNumber = `SHP-${Date.now().toString(36).toUpperCase()}`;
  const parcelId = list.parcelId;

  if (!list.shipmentId) {
    await db.insert(shipments).values({
      id: shipmentId,
      shipmentNumber,
      status: 'shipped',
      type: 'outbound',
      parcelIds: parcelId ? [parcelId] : [],
      totalParcels: parcelId ? 1 : 0,
      carrierName,
      shippedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (parcelId) {
    await db
      .update(parcels)
      .set({
        shipmentId,
        status: 'shipped',
        shippedAt: now,
        trackingNumber,
        carrierName,
        serviceType: shippingOptionCode,
        labelUrl,
        labelFormat: labelUrl || labelPdfBase64 ? 'PDF' : undefined,
        customFields: {
          sendcloudShipmentId,
          sendcloudParcelId,
          shippingOptionCode,
        },
        updatedAt: now,
      })
      .where(eq(parcels.id, parcelId));
  }

  for (const item of items) {
    const qty = item.quantityPicked ?? 0;
    if (qty > 0 && item.inventoryId) {
      await issueAllocatedStock(db, {
        inventoryId: item.inventoryId,
        quantity: qty,
        sourceType: 'pick_list',
        sourceId: list.id,
        sourceNumber: list.pickListNumber,
        reason: `Shipped from ${list.pickListNumber}`,
        performedBy: userId ?? null,
      });
    }
    if (item.orderItemId && qty > 0) {
      await db
        .update(orderItems)
        .set({
          fulfilledQuantity: sql`COALESCE(${orderItems.fulfilledQuantity}, 0) + ${qty}`,
        })
        .where(eq(orderItems.id, item.orderItemId));
    }
  }

  if (orderId) {
    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const remaining = lines.some(
      (line) => (line.quantity ?? 0) - (line.fulfilledQuantity ?? 0) > 0,
    );
    await db
      .update(orders)
      .set({
        fulfillmentStatus: remaining ? 'partial' : 'fulfilled',
        trackingNumber: trackingNumber ?? order?.trackingNumber,
        trackingUrl: trackingUrl ?? order?.trackingUrl,
        shippingCarrier: carrierName ?? order?.shippingCarrier,
        shippedAt: now,
        updatedAt: now,
      })
      .where(eq(orders.id, orderId));
  }

  await db
    .update(pickLists)
    .set({ status: 'shipped', shippedAt: now, shipmentId, updatedAt: now })
    .where(eq(pickLists.id, id));
  await writeActivity(db, {
    activityType: 'ship',
    entityId: id,
    userId,
    warehouseId: list.warehouseId,
    description: `Shipped pick list ${list.pickListNumber}`,
    metadata: { shipmentId, parcelId, trackingNumber, shippingOptionCode },
  });
  return {
    id,
    status: 'shipped',
    shipmentId,
    parcelId,
    trackingNumber,
    trackingUrl,
    labelUrl,
    labelPdfBase64,
    carrierName,
    shippingOptionCode,
  };
}

async function announceSendcloudParcel(
  db: Database,
  params: {
    list: NonNullable<Awaited<ReturnType<typeof loadPickList>>>;
    order: typeof orders.$inferSelect | undefined;
    options: ShipPickListOptions;
  },
) {
  const { list, order, options } = params;
  if (!options.senderId || !options.shippingOptionCode || !options.weightKg) {
    throw new PickListError(
      'Sender, parcel type, and weight are required to ship this order',
      'SHIPPING_NOT_CONFIGURED',
    );
  }
  if (!options.workspaceId && !options.sendcloud) {
    throw new PickListError('Sendcloud is not connected', 'SHIPPING_NOT_CONFIGURED');
  }

  let client = options.sendcloud ?? null;
  let stored = options.workspaceId
    ? await getSendcloudSettings(db, options.workspaceId)
    : null;
  if (!client) {
    const secret = stored ? await decryptSecret(stored.secretKey, options.keyring ?? {}) : null;
    if (!stored?.publicKey || !secret) {
      throw new PickListError('Sendcloud is not connected', 'SHIPPING_NOT_CONFIGURED');
    }
    client = createSendcloudClient({ publicKey: stored.publicKey, secretKey: secret });
  }
  const sender = stored?.senders.find((row) => row.id === options.senderId);
  const method = stored?.methods.find((row) => row.code === options.shippingOptionCode);
  if (stored && (!sender?.enabled || !method?.enabled)) {
    throw new PickListError(
      'Selected sender or parcel type is not enabled',
      'SHIPPING_NOT_CONFIGURED',
    );
  }

  let toAddress;
  try {
    toAddress = toSendcloudToAddress({
      address: order?.shippingAddress,
      name: order?.customerName,
      email: order?.customerEmail,
      phone: order?.customerPhone,
    });
  } catch (err) {
    throw new PickListError(
      err instanceof Error ? err.message : 'Recipient address is incomplete',
      'MISSING_ADDRESS',
    );
  }

  try {
    const announced = await client.announceShipment({
      senderAddressId: options.senderId,
      toAddress,
      shippingOptionCode: options.shippingOptionCode,
      weightKg: options.weightKg,
      orderNumber: order?.orderNumber ?? list.pickListNumber,
    });
    if (announced.errors.length > 0 || !announced.parcel?.trackingNumber) {
      const message = announced.errors[0]?.message || 'Sendcloud did not announce the shipment';
      throw new PickListError(message, 'SENDCLOUD_FAILED');
    }
    return {
      trackingNumber: announced.parcel.trackingNumber,
      trackingUrl: announced.parcel.trackingUrl,
      labelUrl: announced.parcel.labelDocumentUrl,
      labelPdfBase64: announced.parcel.labelPdfBase64,
      carrierName: announced.carrierName,
      shippingOptionCode: announced.shippingOptionCode,
      sendcloudParcelId: announced.parcel.id,
      sendcloudShipmentId: announced.id,
    };
  } catch (err) {
    if (err instanceof PickListError) throw err;
    if (err instanceof SendcloudError) {
      throw new PickListError(err.message, 'SENDCLOUD_FAILED');
    }
    throw err;
  }
}

export async function cancelPickList(db: Database, id: string) {
  const list = await loadPickList(db, id);
  if (!list) return null;
  if (['shipped', 'cancelled'].includes(list.status)) {
    throw new PickListError(`Cannot cancel a pick list in status ${list.status}`, 'INVALID_STATUS');
  }
  const items = await loadItems(db, id);
  for (const item of items) {
    // Pending lines still hold the full required qty. Picked/partial/short
    // lines hold whatever was actually picked (shorts already released).
    const hold =
      item.status === 'pending' || item.status === 'skipped'
        ? item.quantityRequired ?? 0
        : item.quantityPicked ?? 0;
    if (item.inventoryId && hold > 0) {
      try {
        await releaseAllocation(db, { inventoryId: item.inventoryId, quantity: hold });
      } catch (err) {
        if (!(err instanceof StockLedgerError && err.code === 'INSUFFICIENT_ALLOCATION')) throw err;
      }
    }
  }
  const now = new Date();
  await db
    .update(pickLists)
    .set({ status: 'cancelled', updatedAt: now })
    .where(eq(pickLists.id, id));
  return { id, status: 'cancelled' };
}

export function renderPackingSlipHtml(params: {
  pickListNumber: string;
  orderNumber?: string | null;
  warehouseName?: string | null;
  packedAt?: Date | null;
  items: Array<{ sku?: string | null; name: string; quantityPicked: number; locationCode?: string | null }>;
}): string {
  const rows = params.items
    .filter((i) => i.quantityPicked > 0)
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.sku ?? '')}</td><td>${escapeHtml(i.name)}</td><td>${i.quantityPicked}</td><td>${escapeHtml(i.locationCode ?? '')}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Packing slip ${escapeHtml(params.pickListNumber)}</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 32px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .meta { color: #555; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; font-size: 14px; }
  th { text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; color: #666; }
</style></head>
<body>
  <h1>Packing slip ${escapeHtml(params.pickListNumber)}</h1>
  <div class="meta">
    ${params.orderNumber ? `Order ${escapeHtml(params.orderNumber)}<br>` : ''}
    ${params.warehouseName ? `Warehouse ${escapeHtml(params.warehouseName)}<br>` : ''}
    ${params.packedAt ? `Packed ${params.packedAt.toISOString()}` : ''}
  </div>
  <table>
    <thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Location</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
