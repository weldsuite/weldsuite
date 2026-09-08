/**
 * Outbound Picqer publish — push WeldSuite entities to Picqer when the
 * connection (or object) direction allows outbound / bidirectional.
 *
 * Echo-safe: skips when an entity mapping checksum already matches the payload
 * we would send, and stamps lastSyncedAt after a successful push.
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  ConnectorApiError,
  PicqerClient,
  allowsOutboundSync,
  getConnector,
  resolveConnectorObjectDirection,
} from '@weldsuite/connectors';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type { Env } from '../../types';
import { createConnectorClient } from './clients';
import {
  decryptCredentials,
  getConnectionById,
  keyringFromEnv,
  type ConnectorConnectionRow,
} from './connections';

async function sha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function assertOutbound(connection: ConnectorConnectionRow, settingKey: string): void {
  const direction = resolveConnectorObjectDirection({
    direction: connection.direction,
    objectSyncDirections: connection.objectSyncDirections,
    settingKey,
  });
  if (!allowsOutboundSync(direction)) {
    throw new ConnectorApiError({
      message: `Outbound sync disabled for ${settingKey}`,
      status: 400,
      kind: 'permanent',
    });
  }
}

async function findExternalId(
  db: Database,
  connectionId: string,
  externalEntityType: string,
  internalEntityId: string,
): Promise<{ mappingId: string; externalEntityId: string; syncChecksum: string | null } | null> {
  const [row] = await db
    .select({
      mappingId: schema.integrationEntityMappings.id,
      externalEntityId: schema.integrationEntityMappings.externalEntityId,
      syncChecksum: schema.integrationEntityMappings.syncChecksum,
    })
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, externalEntityType),
        eq(schema.integrationEntityMappings.internalEntityId, internalEntityId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function upsertOutboundMapping(args: {
  db: Database;
  connectionId: string;
  externalEntityType: string;
  externalEntityId: string;
  internalEntityType: string;
  internalEntityId: string;
  checksum: string;
  existingMappingId?: string | null;
}): Promise<void> {
  if (args.existingMappingId) {
    await args.db
      .update(schema.integrationEntityMappings)
      .set({
        syncChecksum: args.checksum,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
        externalEntityId: args.externalEntityId,
      })
      .where(eq(schema.integrationEntityMappings.id, args.existingMappingId));
    return;
  }
  await args.db.insert(schema.integrationEntityMappings).values({
    id: generateId('iem'),
    connectionId: args.connectionId,
    externalEntityType: args.externalEntityType,
    externalEntityId: args.externalEntityId,
    internalEntityType: args.internalEntityType,
    internalEntityId: args.internalEntityId,
    syncChecksum: args.checksum,
    lastSyncedAt: new Date(),
  });
}

async function loadPicqerClient(args: {
  db: Database;
  env: Env;
  connectionId: string;
}): Promise<{ connection: ConnectorConnectionRow; client: PicqerClient }> {
  const connection = await getConnectionById(args.db, args.connectionId);
  if (!connection || connection.provider !== 'picqer') {
    throw new ConnectorApiError({
      message: 'Picqer connection not found',
      status: 404,
      kind: 'permanent',
    });
  }
  if (connection.status === 'paused' || connection.deletedAt) {
    throw new ConnectorApiError({
      message: 'Picqer connection is not active',
      status: 400,
      kind: 'permanent',
    });
  }
  const keyring = keyringFromEnv(args.env);
  const credentials = await decryptCredentials(connection.credentials ?? undefined, keyring);
  const client = createConnectorClient(
    'picqer',
    credentials,
    connection.externalAccountId,
  ) as PicqerClient;
  return { connection, client };
}

export async function pushPersonToPicqer(args: {
  db: Database;
  env: Env;
  connectionId: string;
  personId: string;
}): Promise<{ externalId: string }> {
  const { connection, client } = await loadPicqerClient(args);
  assertOutbound(connection, 'customers');

  const [person] = await args.db
    .select()
    .from(schema.people)
    .where(and(eq(schema.people.id, args.personId), isNull(schema.people.deletedAt)))
    .limit(1);
  if (!person) {
    throw new ConnectorApiError({ message: 'Person not found', status: 404, kind: 'permanent' });
  }

  const body = {
    name: person.fullName || person.displayName || [person.firstName, person.lastName].filter(Boolean).join(' '),
    contactname: [person.firstName, person.lastName].filter(Boolean).join(' ') || undefined,
    emailaddress: person.email || undefined,
    telephone: person.directPhone || undefined,
  };
  const checksum = await sha256Hex(JSON.stringify(body));
  const existing = await findExternalId(args.db, args.connectionId, 'picqer_customer', args.personId);
  if (existing?.syncChecksum === checksum) {
    return { externalId: existing.externalEntityId };
  }

  const remote = existing
    ? await client.updateCustomer(existing.externalEntityId, body)
    : await client.createCustomer(body);
  const externalId = String(remote.idcustomer ?? remote.id ?? existing?.externalEntityId ?? '');
  await upsertOutboundMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: 'picqer_customer',
    externalEntityId: externalId,
    internalEntityType: 'person',
    internalEntityId: args.personId,
    checksum,
    existingMappingId: existing?.mappingId,
  });
  return { externalId };
}

export async function pushOrderToPicqer(args: {
  db: Database;
  env: Env;
  connectionId: string;
  orderId: string;
}): Promise<{ externalId: string }> {
  const { connection, client } = await loadPicqerClient(args);
  assertOutbound(connection, 'orders');

  const [order] = await args.db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, args.orderId), isNull(schema.orders.deletedAt)))
    .limit(1);
  if (!order) {
    throw new ConnectorApiError({ message: 'Order not found', status: 404, kind: 'permanent' });
  }

  const items = await args.db
    .select()
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, args.orderId));

  let idcustomer: string | number | undefined;
  if (order.personId) {
    const mapping = await findExternalId(args.db, args.connectionId, 'picqer_customer', order.personId);
    if (mapping) idcustomer = Number(mapping.externalEntityId) || mapping.externalEntityId;
    else {
      const pushed = await pushPersonToPicqer({
        db: args.db,
        env: args.env,
        connectionId: args.connectionId,
        personId: order.personId,
      });
      idcustomer = Number(pushed.externalId) || pushed.externalId;
    }
  }

  const products: Array<Record<string, unknown>> = [];
  for (const item of items) {
    let idproduct: string | number | undefined;
    if (item.productId) {
      const mapping = await findExternalId(args.db, args.connectionId, 'picqer_product', item.productId);
      if (mapping) idproduct = Number(mapping.externalEntityId) || mapping.externalEntityId;
    }
    products.push({
      idproduct,
      productcode: item.sku || undefined,
      name: item.name,
      amount: item.quantity,
      price: Number(item.unitPrice) || 0,
    });
  }

  const body: Record<string, unknown> = {
    reference: order.orderNumber || order.externalOrderId || order.id,
    emailaddress: order.customerEmail || undefined,
    telephone: order.customerPhone || undefined,
    deliveryname: order.customerName || undefined,
    remarks: order.customerNote || undefined,
    idcustomer,
    products,
  };
  const checksum = await sha256Hex(JSON.stringify(body));
  const existing = await findExternalId(args.db, args.connectionId, 'picqer_order', args.orderId);
  if (existing?.syncChecksum === checksum) {
    return { externalId: existing.externalEntityId };
  }

  const remote = existing
    ? await client.updateOrder(existing.externalEntityId, body)
    : await client.createOrder(body);
  const externalId = String(remote.idorder ?? remote.id ?? existing?.externalEntityId ?? '');
  await upsertOutboundMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: 'picqer_order',
    externalEntityId: externalId,
    internalEntityType: 'order',
    internalEntityId: args.orderId,
    checksum,
    existingMappingId: existing?.mappingId,
  });
  return { externalId };
}

export async function pushSupplierToPicqer(args: {
  db: Database;
  env: Env;
  connectionId: string;
  supplierId: string;
}): Promise<{ externalId: string }> {
  const { connection, client } = await loadPicqerClient(args);
  assertOutbound(connection, 'suppliers');

  const [supplier] = await args.db
    .select()
    .from(schema.suppliers)
    .where(and(eq(schema.suppliers.id, args.supplierId), isNull(schema.suppliers.deletedAt)))
    .limit(1);
  if (!supplier) {
    throw new ConnectorApiError({ message: 'Supplier not found', status: 404, kind: 'permanent' });
  }

  const body = {
    name: supplier.name,
    contactname: supplier.contactName || undefined,
    emailaddress: supplier.email || undefined,
    telephone: supplier.phone || undefined,
    address: supplier.addressLine1 || undefined,
    city: supplier.city || undefined,
    zipcode: supplier.postalCode || undefined,
    country: supplier.country || undefined,
    remarks: supplier.notes || undefined,
  };
  const checksum = await sha256Hex(JSON.stringify(body));
  const existing = await findExternalId(args.db, args.connectionId, 'picqer_supplier', args.supplierId);
  if (existing?.syncChecksum === checksum) {
    return { externalId: existing.externalEntityId };
  }

  const remote = existing
    ? await client.updateSupplier(existing.externalEntityId, body)
    : await client.createSupplier(body);
  const externalId = String(remote.idsupplier ?? remote.id ?? existing?.externalEntityId ?? '');
  await upsertOutboundMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: 'picqer_supplier',
    externalEntityId: externalId,
    internalEntityType: 'supplier',
    internalEntityId: args.supplierId,
    checksum,
    existingMappingId: existing?.mappingId,
  });
  return { externalId };
}

export async function pushWarehouseToPicqer(args: {
  db: Database;
  env: Env;
  connectionId: string;
  warehouseId: string;
}): Promise<{ externalId: string }> {
  const { connection, client } = await loadPicqerClient(args);
  assertOutbound(connection, 'warehouses');

  const [warehouse] = await args.db
    .select()
    .from(schema.warehouses)
    .where(and(eq(schema.warehouses.id, args.warehouseId), isNull(schema.warehouses.deletedAt)))
    .limit(1);
  if (!warehouse) {
    throw new ConnectorApiError({ message: 'Warehouse not found', status: 404, kind: 'permanent' });
  }

  const body = {
    name: warehouse.name,
    accepts_orders: warehouse.isActive !== false,
  };
  const checksum = await sha256Hex(JSON.stringify(body));
  const existing = await findExternalId(args.db, args.connectionId, 'picqer_warehouse', args.warehouseId);
  if (existing?.syncChecksum === checksum) {
    return { externalId: existing.externalEntityId };
  }

  const remote = existing
    ? await client.updateWarehouse(existing.externalEntityId, body)
    : await client.createWarehouse(body);
  const externalId = String(remote.idwarehouse ?? remote.id ?? existing?.externalEntityId ?? '');
  await upsertOutboundMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: 'picqer_warehouse',
    externalEntityId: externalId,
    internalEntityType: 'warehouse',
    internalEntityId: args.warehouseId,
    checksum,
    existingMappingId: existing?.mappingId,
  });
  return { externalId };
}

export async function pushStockAdjustmentToPicqer(args: {
  db: Database;
  env: Env;
  connectionId: string;
  productId: string;
  warehouseId: string;
  /** Absolute target on-hand; delta is computed against mapped remote if known. */
  amountDelta: number;
}): Promise<void> {
  const { connection, client } = await loadPicqerClient(args);
  assertOutbound(connection, 'inventory');

  const productMapping = await findExternalId(
    args.db,
    args.connectionId,
    'picqer_product',
    args.productId,
  );
  const warehouseMapping = await findExternalId(
    args.db,
    args.connectionId,
    'picqer_warehouse',
    args.warehouseId,
  );
  if (!productMapping || !warehouseMapping) {
    throw new ConnectorApiError({
      message: 'Product and warehouse must be mapped to Picqer before stock push',
      status: 400,
      kind: 'permanent',
    });
  }
  if (!args.amountDelta) return;
  await client.changeProductStock({
    productId: productMapping.externalEntityId,
    warehouseId: warehouseMapping.externalEntityId,
    amount: args.amountDelta,
  });
}

export async function pushPurchaseOrderToPicqer(args: {
  db: Database;
  env: Env;
  connectionId: string;
  purchaseOrderId: string;
}): Promise<{ externalId: string }> {
  const { connection, client } = await loadPicqerClient(args);
  assertOutbound(connection, 'purchaseOrders');

  const [po] = await args.db
    .select()
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.id, args.purchaseOrderId), isNull(schema.purchaseOrders.deletedAt)))
    .limit(1);
  if (!po) {
    throw new ConnectorApiError({ message: 'Purchase order not found', status: 404, kind: 'permanent' });
  }

  const items = await args.db
    .select()
    .from(schema.purchaseOrderItems)
    .where(eq(schema.purchaseOrderItems.purchaseOrderId, args.purchaseOrderId));

  let idsupplier: string | number | undefined;
  if (po.supplierId) {
    const mapping = await findExternalId(args.db, args.connectionId, 'picqer_supplier', po.supplierId);
    if (mapping) idsupplier = Number(mapping.externalEntityId) || mapping.externalEntityId;
  }

  let idwarehouse: string | number | undefined;
  if (po.warehouseId) {
    const mapping = await findExternalId(args.db, args.connectionId, 'picqer_warehouse', po.warehouseId);
    if (mapping) idwarehouse = Number(mapping.externalEntityId) || mapping.externalEntityId;
  }

  const products: Array<Record<string, unknown>> = [];
  for (const item of items) {
    let idproduct: string | number | undefined;
    if (item.productId) {
      const mapping = await findExternalId(args.db, args.connectionId, 'picqer_product', item.productId);
      if (mapping) idproduct = Number(mapping.externalEntityId) || mapping.externalEntityId;
    }
    products.push({
      idproduct,
      amount: item.quantityOrdered ?? 1,
      price: Number(item.unitPrice ?? 0) || undefined,
    });
  }

  const body = {
    idsupplier,
    idwarehouse,
    supplier_name: po.supplierName || undefined,
    remarks: po.internalNotes || po.supplierNotes || undefined,
    delivery_date: po.expectedDate ? po.expectedDate.toISOString().slice(0, 10) : undefined,
    products,
  };
  const checksum = await sha256Hex(JSON.stringify(body));
  const existing = await findExternalId(
    args.db,
    args.connectionId,
    'picqer_purchase_order',
    args.purchaseOrderId,
  );
  if (existing?.syncChecksum === checksum) {
    return { externalId: existing.externalEntityId };
  }

  const remote = await client.createPurchaseOrder(body);
  const externalId = String(remote.idpurchaseorder ?? remote.id ?? '');
  await upsertOutboundMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: 'picqer_purchase_order',
    externalEntityId: externalId,
    internalEntityType: 'purchase_order',
    internalEntityId: args.purchaseOrderId,
    checksum,
    existingMappingId: existing?.mappingId,
  });
  return { externalId };
}

export async function pushReturnToPicqer(args: {
  db: Database;
  env: Env;
  connectionId: string;
  returnId: string;
}): Promise<{ externalId: string }> {
  const { connection, client } = await loadPicqerClient(args);
  assertOutbound(connection, 'returns');

  const [ret] = await args.db
    .select()
    .from(schema.returns)
    .where(and(eq(schema.returns.id, args.returnId), isNull(schema.returns.deletedAt)))
    .limit(1);
  if (!ret) {
    throw new ConnectorApiError({ message: 'Return not found', status: 404, kind: 'permanent' });
  }

  let idorder: string | number | undefined;
  if (ret.originalOrderId) {
    const mapping = await findExternalId(args.db, args.connectionId, 'picqer_order', ret.originalOrderId);
    if (mapping) idorder = Number(mapping.externalEntityId) || mapping.externalEntityId;
  }

  const body = {
    idorder,
    name: ret.customerName || undefined,
    emailaddress: ret.customerEmail || undefined,
    telephone: ret.customerPhone || undefined,
    remarks: ret.reasonDetails || ret.reason || undefined,
    products: (ret.items ?? []).map((item) => ({
      name: item.productName,
      productcode: item.sku,
      amount: item.quantity,
    })),
  };
  const checksum = await sha256Hex(JSON.stringify(body));
  const existing = await findExternalId(args.db, args.connectionId, 'picqer_return', args.returnId);
  if (existing?.syncChecksum === checksum) {
    return { externalId: existing.externalEntityId };
  }

  const remote = await client.createReturn(body);
  const externalId = String(remote.idreturn ?? remote.id ?? '');
  await upsertOutboundMapping({
    db: args.db,
    connectionId: args.connectionId,
    externalEntityType: 'picqer_return',
    externalEntityId: externalId,
    internalEntityType: 'return',
    internalEntityId: args.returnId,
    checksum,
    existingMappingId: existing?.mappingId,
  });
  return { externalId };
}

/** True when the workspace has an active Picqer connection that can receive this object. */
export function picqerConnectorSupports(settingKey: string): boolean {
  const connector = getConnector('picqer');
  return Boolean(connector?.syncs.some((s) => s.settingKey === settingKey));
}
