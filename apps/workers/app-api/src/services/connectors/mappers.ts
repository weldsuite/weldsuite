/**
 * Provider record → WeldSuite entity mappers.
 *
 * Mappers are pure — no database, no Hono context — so they are unit-testable
 * against captured payloads. Writes happen in `ingest.ts`.
 */

import type { ConnectorEntity } from '@weldsuite/connectors';

export interface MappedProduct {
  entity: 'product';
  externalId: string;
  externalUrl: string | null;
  values: Record<string, unknown>;
}

export interface MappedOrder {
  entity: 'order';
  externalId: string;
  values: Record<string, unknown>;
  lineItems: Array<{
    externalProductId: string | null;
    sku: string | null;
    name: string;
    quantity: number;
    unitPrice: string;
    total: string;
    imageUrl: string | null;
  }>;
  customerExternalId: string | null;
}

export interface MappedPerson {
  entity: 'person';
  externalId: string;
  values: Record<string, unknown>;
}

export type MappedRecord = MappedProduct | MappedOrder | MappedPerson;

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, source);
}

function pickString(source: Record<string, unknown>, paths: string[], maxLength?: number): string | null {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    const str = String(value).trim();
    if (str === '' || str === 'null' || str === 'undefined') continue;
    return maxLength !== undefined && str.length > maxLength ? str.slice(0, maxLength) : str;
  }
  return null;
}

function pickNumber(source: Record<string, unknown>, paths: string[]): number | null {
  const raw = pickString(source, paths);
  if (raw === null) return null;
  const parsed = Number(raw.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 255) || 'item';
}

const PRODUCT_STATUS: Record<string, string> = {
  publish: 'active',
  published: 'active',
  active: 'active',
  draft: 'draft',
  pending: 'draft',
  private: 'inactive',
  archived: 'inactive',
};

const ORDER_STATUS: Record<string, string> = {
  pending: 'pending',
  processing: 'processing',
  'on-hold': 'on_hold',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  refunded: 'refunded',
  failed: 'failed',
};

const PAID_STATUSES = new Set(['completed', 'processing']);

function shopifyImages(record: Record<string, unknown>): Array<{ url: string; altText?: string; id?: string }> {
  const raw = Array.isArray(record.images) ? record.images : [];
  return (raw as Array<Record<string, unknown>>)
    .map((img) => ({
      url: typeof img.src === 'string' ? img.src : typeof img.url === 'string' ? img.url : '',
      altText: typeof img.alt === 'string' ? img.alt : undefined,
      id: img.id !== undefined ? String(img.id) : undefined,
    }))
    .filter((img) => img.url);
}

function mapProduct(record: Record<string, unknown>, externalId: string): MappedProduct | null {
  const name = pickString(record, ['name', 'title'], 255);
  if (!name) return null;
  const slug = pickString(record, ['slug', 'handle'], 255) ?? slugify(name);
  const images = shopifyImages(record);
  const status = PRODUCT_STATUS[pickString(record, ['status']) ?? ''] ?? 'draft';
  const price = pickString(record, ['price', 'regular_price', 'variants.0.price']) ?? '0';
  const sku = pickString(record, ['sku', 'variants.0.sku'], 100);
  const compareAt = pickString(record, ['regular_price', 'variants.0.compare_at_price']);

  return {
    entity: 'product',
    externalId,
    externalUrl: pickString(record, ['permalink', 'url'], 500),
    values: compact({
      name,
      slug,
      sku,
      description: pickString(record, ['description', 'body_html']),
      shortDescription: pickString(record, ['short_description'], 500),
      price,
      compareAtPrice: compareAt && compareAt !== price ? compareAt : null,
      currency: pickString(record, ['currency'], 3) ?? 'EUR',
      status,
      featuredImageUrl: images[0]?.url ?? pickString(record, ['image.src', 'images.0.src'], 500),
      images: images.length ? images : null,
      weight: pickString(record, ['weight', 'variants.0.weight']),
      length: pickString(record, ['dimensions.length']),
      width: pickString(record, ['dimensions.width']),
      height: pickString(record, ['dimensions.height']),
      trackInventory: record.manage_stock === true || pickString(record, ['variants.0.inventory_management']) === 'shopify',
      productType: pickString(record, ['type', 'product_type'], 100),
      vendor: pickString(record, ['vendor'], 255),
      publishedAt: pickString(record, ['date_created_gmt', 'date_created', 'created_at'])
        ? new Date(pickString(record, ['date_created_gmt', 'date_created', 'created_at'])!)
        : null,
    }),
  };
}

function mapAddress(source: Record<string, unknown> | null | undefined) {
  if (!source) return null;
  const address = {
    line1: pickString(source, ['address_1', 'address1', 'line1']),
    line2: pickString(source, ['address_2', 'address2', 'line2']),
    city: pickString(source, ['city']),
    state: pickString(source, ['state']),
    postalCode: pickString(source, ['postcode', 'postal_code', 'zip']),
    country: pickString(source, ['country']),
    name: [pickString(source, ['first_name']), pickString(source, ['last_name'])].filter(Boolean).join(' ') || undefined,
    phone: pickString(source, ['phone']),
  };
  const entries = Object.entries(address).filter(([, v]) => v !== null && v !== undefined && v !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function mapOrder(record: Record<string, unknown>, externalId: string, provider: string): MappedOrder | null {
  const orderNumber = pickString(record, ['number', 'name', 'order_number', 'id'], 50);
  if (!orderNumber) return null;
  const wcStatus = pickString(record, ['status', 'financial_status']) ?? 'pending';
  const billing = (record.billing as Record<string, unknown> | undefined)
    ?? (record.billing_address as Record<string, unknown> | undefined)
    ?? undefined;
  const shipping = (record.shipping as Record<string, unknown> | undefined)
    ?? (record.shipping_address as Record<string, unknown> | undefined)
    ?? undefined;
  const customer = (record.customer as Record<string, unknown> | undefined) ?? undefined;
  const customerName =
    [pickString(billing ?? {}, ['first_name']), pickString(billing ?? {}, ['last_name'])].filter(Boolean).join(' ') ||
    [pickString(customer ?? {}, ['first_name']), pickString(customer ?? {}, ['last_name'])].filter(Boolean).join(' ') ||
    pickString(record, ['customer_name']);
  const lineItemsRaw = Array.isArray(record.line_items) ? (record.line_items as Array<Record<string, unknown>>) : [];
  const paidAt = pickString(record, ['date_paid_gmt', 'date_paid', 'processed_at']);
  const financial = pickString(record, ['financial_status']);
  const paid = Boolean(paidAt) || PAID_STATUSES.has(wcStatus) || financial === 'paid';

  return {
    entity: 'order',
    externalId,
    customerExternalId: pickString(record, ['customer_id']) && pickString(record, ['customer_id']) !== '0'
      ? pickString(record, ['customer_id'])
      : pickString(customer ?? {}, ['id']),
    lineItems: lineItemsRaw.map((item) => ({
      externalProductId: pickString(item, ['product_id']) && pickString(item, ['product_id']) !== '0'
        ? pickString(item, ['product_id'])
        : null,
      sku: pickString(item, ['sku'], 100),
      name: pickString(item, ['name', 'title'], 255) ?? 'Item',
      quantity: pickNumber(item, ['quantity']) ?? 1,
      unitPrice: pickString(item, ['price', 'subtotal']) ?? '0',
      total: pickString(item, ['total']) ?? '0',
      imageUrl: pickString(item, ['image.src'], 500),
    })),
    values: compact({
      orderNumber: orderNumber.replace(/^#/, ''),
      externalOrderId: externalId,
      sourceOrderId: externalId,
      source: provider,
      customerEmail: pickString(billing ?? record, ['email', 'billing.email', 'contact_email', 'email'], 255),
      customerName: customerName ? customerName.slice(0, 255) : null,
      customerPhone: pickString(billing ?? {}, ['phone'], 50),
      status: ORDER_STATUS[wcStatus] ?? (wcStatus === 'paid' ? 'processing' : 'pending'),
      paymentStatus: paid ? 'paid' : 'pending',
      currency: pickString(record, ['currency'], 3) ?? 'EUR',
      subtotal: pickString(record, ['subtotal', 'subtotal_price']) ?? '0',
      discountTotal: pickString(record, ['discount_total', 'total_discounts']) ?? '0',
      shippingTotal: pickString(record, ['shipping_total', 'total_shipping_price_set.shop_money.amount']) ?? '0',
      taxTotal: pickString(record, ['total_tax']) ?? '0',
      total: pickString(record, ['total', 'total_price']) ?? '0',
      billingAddress: mapAddress(billing),
      shippingAddress: mapAddress(shipping),
      paymentMethod: pickString(record, ['payment_method_title', 'payment_method', 'gateway'], 100),
      paidAt: paidAt ? new Date(paidAt) : null,
      customerNote: pickString(record, ['customer_note', 'note']),
      itemCount: lineItemsRaw.length,
      totalQuantity: lineItemsRaw.reduce((sum, item) => sum + (pickNumber(item, ['quantity']) ?? 0), 0),
      completedAt: wcStatus === 'completed' && pickString(record, ['date_completed_gmt', 'date_modified_gmt', 'updated_at'])
        ? new Date(pickString(record, ['date_completed_gmt', 'date_modified_gmt', 'updated_at'])!)
        : null,
    }),
  };
}

function mapPerson(record: Record<string, unknown>, externalId: string, provider: string): MappedPerson | null {
  const email = pickString(record, ['email', 'billing.email'], 255);
  const firstName = pickString(record, ['first_name', 'billing.first_name'], 100);
  const lastName = pickString(record, ['last_name', 'billing.last_name'], 100);
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || email;
  if (!fullName) return null;
  const billing = (record.billing as Record<string, unknown> | undefined)
    ?? (record.default_address as Record<string, unknown> | undefined)
    ?? record;

  return {
    entity: 'person',
    externalId,
    values: compact({
      firstName,
      lastName,
      fullName,
      displayName: fullName.slice(0, 255),
      email,
      directPhone: pickString(billing, ['phone'], 50),
      avatarUrl: pickString(record, ['avatar_url'], 1000),
      primaryAddress: mapAddress(billing),
      source: provider,
      inCrm: true,
      status: 'active',
    }),
  };
}

export function isDeletedRecord(record: Record<string, unknown>, forceDeleted = false): boolean {
  if (forceDeleted) return true;
  const status = pickString(record, ['status']);
  return status === 'trash' || status === 'deleted';
}

export function externalIdOf(record: Record<string, unknown>): string | null {
  return pickString(record, ['id', 'external_id'], 255);
}

export function modifiedAtOf(record: Record<string, unknown>): string | null {
  return pickString(record, ['date_modified_gmt', 'date_modified', 'updated_at', 'date_created_gmt', 'created_at']);
}

export function mapConnectorRecord(
  entity: ConnectorEntity,
  record: Record<string, unknown>,
  provider = 'woocommerce',
): MappedRecord | null {
  const externalId = externalIdOf(record);
  if (!externalId) return null;
  switch (entity) {
    case 'product':
      return mapProduct(record, externalId);
    case 'order':
      return mapOrder(record, externalId, provider);
    case 'person':
      return mapPerson(record, externalId, provider);
  }
}
