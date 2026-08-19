/**
 * Place a B2B portal order: server-priced catalog lines, header + items
 * written together. Callers must already have resolved the buyer party.
 *
 * Client-supplied prices are ignored. Stock reservation and tax calculation
 * are deferred (WeldCommerce phases 3–4).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

export class PortalOrderError extends Error {
  constructor(
    public readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'PortalOrderError';
  }
}

export interface PlacePortalOrderItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
}

export interface PlacePortalOrderInput {
  items: PlacePortalOrderItemInput[];
  customerNote?: string;
  purchaseOrderNumber?: string;
  shippingAddress?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    name?: string;
    phone?: string;
  };
}

export interface PlacedPortalOrder {
  order: typeof schema.orders.$inferSelect;
  items: Array<typeof schema.orderItems.$inferSelect>;
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function toOrderAddress(
  addr:
    | PlacePortalOrderInput['shippingAddress']
    | { line1?: string; line2?: string; street?: string; city?: string; state?: string; postalCode?: string; country?: string }
    | null
    | undefined,
) {
  if (!addr) return undefined;
  const line1 = 'line1' in addr ? addr.line1 : undefined;
  const street = 'street' in addr ? addr.street : undefined;
  return {
    line1: line1 || street,
    line2: addr.line2,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postalCode,
    country: addr.country,
    name: 'name' in addr ? addr.name : undefined,
    phone: 'phone' in addr ? addr.phone : undefined,
  };
}

export async function placePortalOrder(
  db: Database,
  params: {
    personId: string;
    companyId: string;
    partyId: string;
    personEmail?: string | null;
    personName?: string | null;
    input: PlacePortalOrderInput;
  },
): Promise<PlacedPortalOrder> {
  const { input } = params;
  if (!input.items.length) {
    throw new PortalOrderError(400, 'At least one line item is required');
  }

  const [party] = await db
    .select()
    .from(schema.parties)
    .where(and(eq(schema.parties.id, params.partyId), isNull(schema.parties.deletedAt)))
    .limit(1);
  if (!party) throw new PortalOrderError(400, 'Company has no commercial party record');

  const lines: Array<{
    productId: string;
    variantId?: string;
    sku: string | null;
    name: string;
    imageUrl: string | null;
    quantity: number;
    unitPrice: string;
    total: string;
    requiresShipping: number;
  }> = [];

  let subtotalNum = 0;
  let currency = party.currency || 'EUR';

  for (const line of input.items) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new PortalOrderError(400, 'Each line quantity must be a positive integer');
    }

    const [product] = await db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.id, line.productId), isNull(schema.products.deletedAt)))
      .limit(1);

    if (!product || product.status !== 'active' || (product.visibility && product.visibility !== 'visible')) {
      throw new PortalOrderError(400, 'One or more products are unavailable');
    }

    let unitPrice = Number(product.price ?? 0);
    let sku = product.sku ?? null;
    let name = product.name;
    let imageUrl = product.featuredImageUrl ?? product.images?.[0]?.url ?? null;
    let requiresShipping = product.requiresShipping === false ? 0 : 1;

    if (line.variantId) {
      const [variant] = await db
        .select()
        .from(schema.productVariants)
        .where(
          and(
            eq(schema.productVariants.id, line.variantId),
            eq(schema.productVariants.productId, product.id),
            isNull(schema.productVariants.deletedAt),
          ),
        )
        .limit(1);
      if (!variant || variant.status !== 'active') {
        throw new PortalOrderError(400, 'One or more products are unavailable');
      }
      if (variant.price != null) unitPrice = Number(variant.price);
      sku = variant.sku ?? sku;
      name = variant.name || name;
      imageUrl = variant.imageUrl ?? imageUrl;
      if (variant.requiresShipping === false) requiresShipping = 0;
    }

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new PortalOrderError(400, 'One or more products have no price');
    }

    if (!party.currency && product.currency) currency = product.currency;

    const lineTotalNum = unitPrice * line.quantity;
    subtotalNum += lineTotalNum;
    lines.push({
      productId: product.id,
      variantId: line.variantId,
      sku,
      name,
      imageUrl,
      quantity: line.quantity,
      unitPrice: money(unitPrice),
      total: money(lineTotalNum),
      requiresShipping,
    });
  }

  const now = new Date();
  const orderId = generateId('ord');
  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const subtotal = money(subtotalNum);
  const shipping = toOrderAddress(input.shippingAddress) ?? toOrderAddress(party.shippingAddress) ?? toOrderAddress(party.billingAddress);
  const billing = toOrderAddress(party.billingAddress) ?? shipping;

  await db.insert(schema.orders).values({
    id: orderId,
    createdAt: now,
    updatedAt: now,
    orderNumber,
    customerEmail: params.personEmail ?? undefined,
    customerName: params.personName ?? party.displayName ?? undefined,
    counterpartyId: params.partyId,
    personId: params.personId,
    status: 'pending',
    paymentStatus: 'pending',
    fulfillmentStatus: 'unfulfilled',
    currency,
    subtotal,
    discountTotal: '0.00',
    shippingTotal: '0.00',
    taxTotal: '0.00',
    total: subtotal,
    taxExempt: party.taxExempt ? 1 : 0,
    billingAddress: billing,
    shippingAddress: shipping,
    paymentMethod: 'account',
    paymentReference: input.purchaseOrderNumber || undefined,
    customerNote: input.customerNote,
    itemCount: lines.length,
    totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
    source: 'b2b_portal',
  });

  const itemRows = lines.map((line) => ({
    id: generateId('oi'),
    orderId,
    createdAt: now,
    productId: line.productId,
    variantId: line.variantId,
    sku: line.sku,
    name: line.name,
    imageUrl: line.imageUrl,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountAmount: '0.00',
    taxAmount: '0.00',
    total: line.total,
    requiresShipping: line.requiresShipping,
  }));

  await db.insert(schema.orderItems).values(itemRows);

  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId));

  return { order: order!, items };
}
