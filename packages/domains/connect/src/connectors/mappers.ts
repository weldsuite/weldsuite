/**
 * Provider record → WeldSuite entity mappers.
 *
 * Mappers are pure — no database, no Hono context — so they are unit-testable
 * against captured payloads. Writes happen in `ingest.ts`.
 */

import type { ConnectorEntity } from '@weldsuite/connectors';

export interface MappedProductVariant {
  externalId: string;
  sku: string | null;
  name: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  trackInventory: boolean;
  optionValues: Record<string, string> | null;
  status: string;
  position: number;
}

export interface MappedProduct {
  entity: 'product';
  externalId: string;
  externalUrl: string | null;
  values: Record<string, unknown>;
  variants?: MappedProductVariant[];
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

export interface MappedDocumentLine {
  externalProductId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string | null;
  taxAmount: string | null;
  lineTotal: string | null;
  lineTotalWithTax: string | null;
  sortOrder: number;
}

export interface MappedParty {
  entity: 'party';
  externalId: string;
  kind: 'company' | 'person';
  identity: Record<string, unknown>;
  values: Record<string, unknown>;
}

export interface MappedInvoice {
  entity: 'invoice';
  externalId: string;
  contactExternalId: string | null;
  nestedContact: Record<string, unknown> | null;
  values: Record<string, unknown>;
  lineItems: MappedDocumentLine[];
}

export interface MappedBill {
  entity: 'bill';
  externalId: string;
  contactExternalId: string | null;
  nestedContact: Record<string, unknown> | null;
  values: Record<string, unknown>;
  lineItems: MappedDocumentLine[];
}

export interface MappedBankAccount {
  entity: 'bank_account';
  externalId: string;
  values: Record<string, unknown>;
}

export interface MappedBankTransaction {
  entity: 'bank_transaction';
  externalId: string;
  financialAccountExternalId: string | null;
  values: Record<string, unknown>;
}

export interface MappedWmsEntity {
  entity:
    | 'inventory'
    | 'warehouse'
    | 'location'
    | 'picklist'
    | 'shipment'
    | 'supplier'
    | 'purchase_order'
    | 'return'
    | 'stock_count'
    | 'inventory_movement';
  externalId: string;
  values: Record<string, unknown>;
  /** Related external ids for mapping resolution during ingest. */
  links?: {
    productExternalId?: string | null;
    warehouseExternalId?: string | null;
    locationExternalId?: string | null;
    orderExternalId?: string | null;
    supplierExternalId?: string | null;
    picklistExternalId?: string | null;
  };
}

export type MappedRecord =
  | MappedProduct
  | MappedOrder
  | MappedPerson
  | MappedParty
  | MappedInvoice
  | MappedBill
  | MappedBankAccount
  | MappedBankTransaction
  | MappedWmsEntity;

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

function mapProductOptionValues(
  record: Record<string, unknown>,
  productOptions: Array<{ name: string }>,
): Record<string, string> | null {
  const fromAttrs = Array.isArray(record.attributes) ? (record.attributes as Array<Record<string, unknown>>) : [];
  if (fromAttrs.length > 0) {
    const values: Record<string, string> = {};
    for (const attr of fromAttrs) {
      const attrName = pickString(attr, ['name']);
      const option = pickString(attr, ['option']);
      if (attrName && option) values[attrName] = option;
    }
    return Object.keys(values).length ? values : null;
  }

  const values: Record<string, string> = {};
  for (let i = 0; i < 3; i++) {
    const optionName = productOptions[i]?.name;
    const optionValue = pickString(record, [`option${i + 1}`]);
    if (optionName && optionValue) values[optionName] = optionValue;
  }
  return Object.keys(values).length ? values : null;
}

function mapProductVariants(record: Record<string, unknown>): MappedProductVariant[] {
  const wooRaw = Array.isArray(record._variations)
    ? (record._variations as Array<Record<string, unknown>>)
    : Array.isArray(record.variations) && record.variations.some((v) => v && typeof v === 'object')
      ? (record.variations as Array<Record<string, unknown>>)
      : null;
  const shopifyRaw = !wooRaw && Array.isArray(record.variants)
    ? (record.variants as Array<Record<string, unknown>>)
    : null;
  const raw = wooRaw ?? shopifyRaw ?? [];
  if (raw.length === 0) return [];

  const productOptions = Array.isArray(record.options)
    ? (record.options as Array<Record<string, unknown>>)
        .map((opt) => ({ name: pickString(opt, ['name']) ?? '' }))
        .filter((opt) => opt.name)
    : [];

  const mapped: MappedProductVariant[] = [];
  for (let i = 0; i < raw.length; i++) {
    const variant = raw[i]!;
    const externalId = variant.id !== undefined && variant.id !== null ? String(variant.id) : null;
    if (!externalId) continue;
    const optionValues = mapProductOptionValues(variant, productOptions);
    const status = PRODUCT_STATUS[pickString(variant, ['status']) ?? ''] ?? 'active';
    const trackInventory =
      variant.manage_stock === true
      || pickString(variant, ['inventory_management']) === 'shopify';
    mapped.push({
      externalId,
      sku: pickString(variant, ['sku'], 100),
      name:
        pickString(variant, ['name', 'title'], 255)
        ?? (optionValues ? Object.values(optionValues).join(' / ') : null),
      price: pickString(variant, ['price', 'regular_price']),
      inventoryQuantity: pickNumber(variant, ['stock_quantity', 'inventory_quantity']),
      trackInventory,
      optionValues,
      status,
      position: pickNumber(variant, ['menu_order', 'position']) ?? i,
    });
  }
  return mapped;
}

function picqerFreeStockTotal(record: Record<string, unknown>): number | null {
  const stock = Array.isArray(record.stock) ? (record.stock as Array<Record<string, unknown>>) : [];
  if (stock.length === 0) return pickNumber(record, ['freestock', 'stock']);
  let total = 0;
  for (const row of stock) {
    total += pickNumber(row, ['freestock', 'stock']) ?? 0;
  }
  return total;
}

function mapProduct(record: Record<string, unknown>, externalId: string): MappedProduct | null {
  const name = pickString(record, ['name', 'title'], 255);
  if (!name) return null;
  const slug = pickString(record, ['slug', 'handle'], 255) ?? slugify(name);
  const images = shopifyImages(record);
  const picqerActive = record.active;
  const statusFromActive =
    picqerActive === true ? 'active' : picqerActive === false ? 'inactive' : null;
  const status =
    statusFromActive
    ?? PRODUCT_STATUS[pickString(record, ['status']) ?? '']
    ?? 'draft';
  const price = pickString(record, ['price', 'regular_price', 'variants.0.price']) ?? '0';
  const sku = pickString(record, ['sku', 'productcode', 'identifier', 'variants.0.sku'], 100);
  const compareAt = pickString(record, ['regular_price', 'variants.0.compare_at_price']);
  const shopifyVariantCount = Array.isArray(record.variants) ? record.variants.length : 0;
  const hasVariants = record.type === 'variable' || shopifyVariantCount > 1;
  const variants = mapProductVariants(record);
  const inventoryQuantity =
    picqerFreeStockTotal(record)
    ?? pickNumber(record, ['stock_quantity', 'variants.0.inventory_quantity']);

  return {
    entity: 'product',
    externalId,
    externalUrl: pickString(record, ['permalink', 'url'], 500),
    values: compact({
      name,
      slug,
      sku,
      barcode: pickString(record, ['barcode'], 100),
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
      trackInventory:
        record.unlimitedstock === true
          ? false
          : record.manage_stock === true
            || pickString(record, ['variants.0.inventory_management']) === 'shopify'
            || Array.isArray(record.stock),
      inventoryQuantity,
      hasVariants,
      variantCount: hasVariants ? variants.length : 0,
      productType: pickString(record, ['type', 'product_type'], 100),
      vendor: pickString(record, ['vendor'], 255),
      publishedAt: pickString(record, ['date_created_gmt', 'date_created', 'created_at'])
        ? new Date(pickString(record, ['date_created_gmt', 'date_created', 'created_at'])!)
        : null,
    }),
    ...(hasVariants && variants.length ? { variants } : {}),
  };
}

function mapAddress(source: Record<string, unknown> | null | undefined) {
  if (!source) return null;
  const address = {
    line1: pickString(source, ['address_1', 'address1', 'line1', 'street']),
    line2: pickString(source, ['address_2', 'address2', 'line2']),
    city: pickString(source, ['city']),
    state: pickString(source, ['state', 'province']),
    postalCode: pickString(source, ['postcode', 'postal_code', 'zip', 'zipcode']),
    country: pickString(source, ['country']),
    name: [pickString(source, ['first_name', 'firstname']), pickString(source, ['last_name', 'lastname'])].filter(Boolean).join(' ') || undefined,
    phone: pickString(source, ['phone']),
  };
  const entries = Object.entries(address).filter(([, v]) => v !== null && v !== undefined && v !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

const PICQER_ORDER_STATUS: Record<string, string> = {
  concept: 'pending',
  expected: 'processing',
  processing: 'processing',
  paused: 'on_hold',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

function mapOrder(record: Record<string, unknown>, externalId: string, provider: string): MappedOrder | null {
  const orderNumber = pickString(record, ['number', 'name', 'orderid', 'order_number', 'reference', 'id'], 50);
  if (!orderNumber) return null;
  const wcStatus = pickString(record, ['status', 'financial_status']) ?? 'pending';
  const billing = (record.billing as Record<string, unknown> | undefined)
    ?? (record.billing_address as Record<string, unknown> | undefined)
    ?? undefined;
  const shipping = (record.shipping as Record<string, unknown> | undefined)
    ?? (record.shipping_address as Record<string, unknown> | undefined)
    ?? (provider === 'picqer'
      ? ({
          address_1: pickString(record, ['deliveryname', 'address']),
          address1: pickString(record, ['address']),
          address_2: pickString(record, ['address2']),
          city: pickString(record, ['city']),
          zip: pickString(record, ['zipcode']),
          country: pickString(record, ['country']),
          phone: pickString(record, ['telephone']),
        } as Record<string, unknown>)
      : undefined);
  const customer = (record.customer as Record<string, unknown> | undefined) ?? undefined;
  const customerName =
    [pickString(billing ?? {}, ['first_name']), pickString(billing ?? {}, ['last_name'])].filter(Boolean).join(' ') ||
    [pickString(customer ?? {}, ['first_name']), pickString(customer ?? {}, ['last_name'])].filter(Boolean).join(' ') ||
    pickString(record, ['customer_name', 'deliveryname', 'name']);
  const lineItemsRaw = Array.isArray(record.line_items)
    ? (record.line_items as Array<Record<string, unknown>>)
    : Array.isArray(record.products)
      ? (record.products as Array<Record<string, unknown>>)
      : [];
  const paidAt = pickString(record, ['date_paid_gmt', 'date_paid', 'processed_at']);
  const financial = pickString(record, ['financial_status']);
  const paid = Boolean(paidAt) || PAID_STATUSES.has(wcStatus) || financial === 'paid';
  const mappedStatus =
    PICQER_ORDER_STATUS[wcStatus]
    ?? ORDER_STATUS[wcStatus]
    ?? (wcStatus === 'paid' ? 'processing' : 'pending');

  return {
    entity: 'order',
    externalId,
    customerExternalId:
      (pickString(record, ['customer_id', 'idcustomer']) && pickString(record, ['customer_id', 'idcustomer']) !== '0'
        ? pickString(record, ['customer_id', 'idcustomer'])
        : null)
      ?? pickString(customer ?? {}, ['id', 'idcustomer']),
    lineItems: lineItemsRaw.map((item) => ({
      externalProductId:
        pickString(item, ['product_id', 'idproduct']) && pickString(item, ['product_id', 'idproduct']) !== '0'
          ? pickString(item, ['product_id', 'idproduct'])
          : null,
      sku: pickString(item, ['sku', 'productcode'], 100),
      name: pickString(item, ['name', 'title'], 255) ?? 'Item',
      quantity: pickNumber(item, ['quantity', 'amount']) ?? 1,
      unitPrice: pickString(item, ['price', 'subtotal']) ?? '0',
      total: pickString(item, ['total', 'price']) ?? '0',
      imageUrl: pickString(item, ['image.src'], 500),
    })),
    values: compact({
      orderNumber: orderNumber.replace(/^#/, ''),
      externalOrderId: pickString(record, ['reference']) ?? externalId,
      sourceOrderId: externalId,
      source: provider,
      customerEmail: pickString(
        billing ?? record,
        ['email', 'emailaddress', 'billing.email', 'contact_email'],
        255,
      ),
      customerName: customerName ? customerName.slice(0, 255) : null,
      customerPhone: pickString(billing ?? record, ['phone', 'telephone'], 50),
      status: mappedStatus,
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
      customerNote: pickString(record, ['customer_note', 'note', 'remarks']),
      itemCount: lineItemsRaw.length,
      totalQuantity: lineItemsRaw.reduce(
        (sum, item) => sum + (pickNumber(item, ['quantity', 'amount']) ?? 0),
        0,
      ),
      fulfillmentStatus: mappedStatus === 'completed' ? 'fulfilled' : null,
      completedAt: mappedStatus === 'completed' && pickString(record, ['date_completed_gmt', 'date_modified_gmt', 'updated_at', 'completed_at'])
        ? new Date(pickString(record, ['date_completed_gmt', 'date_modified_gmt', 'updated_at', 'completed_at'])!)
        : null,
    }),
  };
}

function mapPerson(record: Record<string, unknown>, externalId: string, provider: string): MappedPerson | null {
  const email = pickString(record, ['email', 'emailaddress', 'billing.email'], 255);
  const firstName = pickString(record, ['first_name', 'firstname', 'billing.first_name', 'contactname'], 100);
  const lastName = pickString(record, ['last_name', 'lastname', 'billing.last_name'], 100);
  const companyOrName = pickString(record, ['name', 'company_name'], 255);
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || companyOrName || email;
  if (!fullName) return null;
  const billing = (record.billing as Record<string, unknown> | undefined)
    ?? (record.default_address as Record<string, unknown> | undefined)
    ?? record;

  return {
    entity: 'person',
    externalId,
    values: compact({
      firstName: firstName ?? (companyOrName && !lastName ? companyOrName : null),
      lastName,
      fullName,
      displayName: fullName.slice(0, 255),
      email,
      directPhone: pickString(billing, ['phone', 'telephone'], 50),
      avatarUrl: pickString(record, ['avatar_url'], 1000),
      primaryAddress: mapAddress({
        ...billing,
        address_1: pickString(billing, ['address_1', 'address', 'address1']),
        postcode: pickString(billing, ['postcode', 'zipcode', 'zip']),
      }),
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
  return pickString(
    record,
    [
      'id',
      'external_id',
      'entity_id',
      'idproduct',
      'idorder',
      'idcustomer',
      'idwarehouse',
      'idlocation',
      'idpicklist',
      'idshipment',
      'idsupplier',
      'idpurchaseorder',
      'idreturn',
      'idmovement',
      'idlocation_stock_count',
    ],
    255,
  );
}

export function modifiedAtOf(record: Record<string, unknown>): string | null {
  return pickString(record, [
    'date_modified_gmt',
    'date_modified',
    'updated_at',
    'updated_at_formatted',
    'date_created_gmt',
    'created_at',
    'created',
  ]);
}

const INVOICE_STATUS: Record<string, string> = {
  draft: 'draft',
  open: 'sent',
  late: 'overdue',
  paid: 'paid',
  uncollectible: 'uncollectible',
};

const BILL_STATUS: Record<string, string> = {
  new: 'draft',
  saved: 'draft',
  open: 'approved',
  pending_payment: 'approved',
  late: 'overdue',
  paid: 'paid',
};

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function decimalString(value: string | null, fallback = '0'): string {
  if (!value) return fallback;
  const parsed = Number(value.replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed.toFixed(2) : fallback;
}

function quantityString(value: string | null): string {
  if (!value) return '1';
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return '1';
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed !== 0 ? String(parsed) : '1';
}

function mapDocumentLines(record: Record<string, unknown>): MappedDocumentLine[] {
  const raw = Array.isArray(record.details)
    ? (record.details as Array<Record<string, unknown>>)
    : Array.isArray(record.line_items)
      ? (record.line_items as Array<Record<string, unknown>>)
      : [];
  return raw.map((item, index) => {
    const quantity = quantityString(pickString(item, ['amount', 'quantity']));
    const unitPrice = decimalString(pickString(item, ['price', 'unit_price']));
    const lineExcl = decimalString(
      pickString(item, ['total_price_excl_tax_with_discount', 'total_price_excl_tax', 'total']),
      String((Number(quantity) || 1) * (Number(unitPrice) || 0)),
    );
    const lineIncl = decimalString(
      pickString(item, ['total_price_incl_tax_with_discount', 'total_price_incl_tax']),
      lineExcl,
    );
    return {
      externalProductId: pickString(item, ['product_id']) && pickString(item, ['product_id']) !== '0'
        ? pickString(item, ['product_id'])
        : null,
      description: pickString(item, ['description', 'name'], 2000) ?? 'Item',
      quantity,
      unitPrice,
      taxRate: pickString(item, ['tax_rate', 'tax']),
      taxAmount: pickString(item, ['tax_amount', 'tax']),
      lineTotal: lineExcl,
      lineTotalWithTax: lineIncl,
      sortOrder: index,
    };
  });
}

function nestedContactRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  const contact = record.contact;
  if (contact && typeof contact === 'object' && !Array.isArray(contact)) {
    return contact as Record<string, unknown>;
  }
  return null;
}

function mapParty(record: Record<string, unknown>, externalId: string, provider: string): MappedParty | null {
  const companyName = pickString(record, ['company_name', 'companyName'], 255);
  const firstName = pickString(record, ['firstname', 'first_name'], 100);
  const lastName = pickString(record, ['lastname', 'last_name'], 100);
  const email = pickString(record, ['email', 'send_invoices_to_email'], 255);
  const personName = [firstName, lastName].filter(Boolean).join(' ') || email;
  const kind: 'company' | 'person' = companyName ? 'company' : 'person';
  const displayName = (kind === 'company' ? companyName : personName) || email;
  if (!displayName) return null;

  const address = mapAddress(record);
  const phone = pickString(record, ['phone'], 50);

  const identity = kind === 'company'
    ? compact({
        name: companyName,
        displayName: displayName.slice(0, 255),
        email,
        phone,
        vatNumber: pickString(record, ['tax_number', 'vat_number'], 50),
        registrationNumber: pickString(record, ['chamber_of_commerce'], 100),
        primaryAddress: address,
        source: provider,
        status: 'active',
        ownerId: null,
      })
    : compact({
        firstName,
        lastName,
        fullName: personName,
        displayName: displayName.slice(0, 255),
        email,
        directPhone: phone,
        primaryAddress: address,
        source: provider,
        status: 'active',
        inCrm: false,
      });

  return {
    entity: 'party',
    externalId,
    kind,
    identity,
    values: compact({
      kind,
      displayName: displayName.slice(0, 255),
      billingAddress: address,
      iban: pickString(record, ['sepa_iban', 'iban'], 34),
      bic: pickString(record, ['sepa_bic', 'bic'], 11),
      partyCode: pickString(record, ['customer_id'], 50),
      status: 'active',
      role: 'none',
    }),
  };
}

function mapInvoice(record: Record<string, unknown>, externalId: string): MappedInvoice | null {
  const invoiceNumber = pickString(record, ['invoice_id', 'invoice_number', 'reference', 'id'], 50);
  if (!invoiceNumber) return null;
  const state = (pickString(record, ['state', 'status']) ?? 'draft').toLowerCase();
  const issueDate = parseDate(pickString(record, ['invoice_date', 'date', 'created_at'])) ?? new Date();
  const dueDate = parseDate(pickString(record, ['due_date'])) ?? issueDate;
  const paidAt = parseDate(pickString(record, ['paid_at']));
  const nested = nestedContactRecord(record);
  const contactName = pickString(nested ?? {}, ['company_name', 'firstname'])
    ?? pickString(record, ['contact.company_name', 'contact_name']);
  const subtotal = decimalString(pickString(record, ['total_price_excl_tax', 'subtotal']));
  const total = decimalString(pickString(record, ['total_price_incl_tax', 'total']));
  const taxTotal = decimalString(pickString(record, ['total_tax', 'tax_total']));

  return {
    entity: 'invoice',
    externalId,
    contactExternalId: pickString(record, ['contact_id']) && pickString(record, ['contact_id']) !== '0'
      ? pickString(record, ['contact_id'])
      : pickString(nested ?? {}, ['id']),
    nestedContact: nested,
    lineItems: mapDocumentLines(record),
    values: compact({
      invoiceNumber,
      type: 'standard',
      status: INVOICE_STATUS[state] ?? 'draft',
      contactName: contactName ? contactName.slice(0, 255) : null,
      contactEmail: pickString(nested ?? record, ['email', 'send_invoices_to_email'], 255),
      issueDate,
      dueDate,
      paidAt,
      sentAt: state !== 'draft' ? issueDate : null,
      currency: pickString(record, ['currency'], 3) ?? 'EUR',
      subtotal,
      taxTotal,
      total,
      amountPaid: paidAt ? total : '0',
      balanceDue: paidAt ? '0' : total,
      reference: pickString(record, ['reference'], 255),
      notes: pickString(record, ['notes']),
      journalEntryId: null,
    }),
  };
}

function mapBill(record: Record<string, unknown>, externalId: string): MappedBill | null {
  const billNumber = pickString(record, ['reference', 'invoice_id', 'id'], 50);
  if (!billNumber) return null;
  const state = (pickString(record, ['state', 'status']) ?? 'new').toLowerCase();
  const issueDate = parseDate(pickString(record, ['date', 'invoice_date', 'created_at'])) ?? new Date();
  const dueDate = parseDate(pickString(record, ['due_date'])) ?? issueDate;
  const paidAt = parseDate(pickString(record, ['paid_at']));
  const nested = nestedContactRecord(record);
  const contactName = pickString(nested ?? {}, ['company_name', 'firstname'])
    ?? pickString(record, ['contact.company_name', 'contact_name']);
  const subtotal = decimalString(pickString(record, ['total_price_excl_tax', 'subtotal']));
  const total = decimalString(pickString(record, ['total_price_incl_tax', 'total']));
  const taxTotal = decimalString(pickString(record, ['total_tax', 'tax_total']));

  return {
    entity: 'bill',
    externalId,
    contactExternalId: pickString(record, ['contact_id']) && pickString(record, ['contact_id']) !== '0'
      ? pickString(record, ['contact_id'])
      : pickString(nested ?? {}, ['id']),
    nestedContact: nested,
    lineItems: mapDocumentLines(record),
    values: compact({
      billNumber,
      type: 'standard',
      status: BILL_STATUS[state] ?? 'draft',
      contactName: contactName ? contactName.slice(0, 255) : null,
      issueDate,
      dueDate,
      paidAt,
      currency: pickString(record, ['currency'], 3) ?? 'EUR',
      subtotal,
      taxTotal,
      total,
      amountPaid: paidAt ? total : '0',
      balanceDue: paidAt ? '0' : total,
      reference: pickString(record, ['reference'], 255),
      notes: pickString(record, ['notes']),
      journalEntryId: null,
    }),
  };
}

function looksLikeIban(value: string | null): string | null {
  if (!value) return null;
  const compactIban = value.replace(/\s+/g, '').toUpperCase();
  if (compactIban.length < 15 || compactIban.length > 34) return null;
  if (!/^[A-Z]{2}[0-9A-Z]+$/.test(compactIban)) return null;
  return compactIban.slice(0, 34);
}

function mapBankAccount(record: Record<string, unknown>, externalId: string): MappedBankAccount | null {
  // Moneybird often leaves `name` blank for manually added IBAN accounts and
  // shows `identifier` (the IBAN) in the UI instead.
  const identifier = pickString(record, ['identifier'], 100);
  const name =
    pickString(record, ['name'], 255)
    ?? identifier
    ?? pickString(record, ['provider'], 255)
    ?? `Moneybird account ${externalId}`;
  const iban = looksLikeIban(identifier);
  const active = record.active === undefined ? true : Boolean(record.active);

  return {
    entity: 'bank_account',
    externalId,
    values: compact({
      name: name.slice(0, 255),
      iban,
      currency: pickString(record, ['currency'], 3) ?? 'EUR',
      bankName: pickString(record, ['provider', 'type'], 255),
      isActive: active,
      metadata: {
        moneybirdType: pickString(record, ['type']),
        moneybirdIdentifier: identifier,
        moneybirdAccount: record.moneybird_account === true,
      },
    }),
  };
}

function mapBankTransaction(record: Record<string, unknown>, externalId: string): MappedBankTransaction | null {
  const amountRaw = pickString(record, ['amount', 'original_amount']);
  if (!amountRaw) return null;
  const amount = decimalString(amountRaw, '');
  if (!amount || !Number.isFinite(Number(amount))) return null;
  // Zero-amount mutations are rare but valid (info lines); keep them.
  const date = parseDate(pickString(record, ['date', 'created_at', 'processed_at']));
  if (!date) return null;

  const state = (pickString(record, ['state']) ?? 'unprocessed').toLowerCase();
  const status = state === 'processed' || state === 'auto_booked' ? 'reconciled' : 'unreconciled';
  const contra = pickString(record, ['contra_account_number'], 50);
  const description =
    pickString(record, ['message'])
    ?? pickString(record, ['batch_reference'])
    ?? pickString(record, ['code'])
    ?? null;

  return {
    entity: 'bank_transaction',
    externalId,
    financialAccountExternalId: pickString(record, ['financial_account_id']),
    values: compact({
      date,
      valueDate: date,
      amount,
      description,
      counterpartyName: pickString(record, ['contra_account_name'], 255),
      counterpartyIban: looksLikeIban(contra) ?? (contra && contra.replace(/\s+/g, '').length <= 34
        ? contra.replace(/\s+/g, '').slice(0, 34)
        : null),
      reference: pickString(record, ['batch_reference', 'code', 'account_servicer_transaction_id'], 255),
      externalId,
      status,
      rawData: record,
    }),
  };
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
    case 'party':
      return mapParty(record, externalId, provider);
    case 'invoice':
      return mapInvoice(record, externalId);
    case 'bill':
      return mapBill(record, externalId);
    case 'bank_account':
      return mapBankAccount(record, externalId);
    case 'bank_transaction':
      return mapBankTransaction(record, externalId);
    case 'inventory':
      return mapInventory(record, externalId);
    case 'warehouse':
      return mapWarehouse(record, externalId);
    case 'location':
      return mapLocation(record, externalId);
    case 'picklist':
      return mapPicklist(record, externalId);
    case 'shipment':
      return mapShipment(record, externalId);
    case 'supplier':
      return mapSupplier(record, externalId);
    case 'purchase_order':
      return mapPurchaseOrder(record, externalId);
    case 'return':
      return mapReturn(record, externalId);
    case 'stock_count':
      return mapStockCount(record, externalId);
    case 'inventory_movement':
      return mapInventoryMovement(record, externalId);
  }
}

const PICKLIST_STATUS: Record<string, string> = {
  new: 'pending',
  open: 'pending',
  processing: 'in_progress',
  paused: 'assigned',
  closed: 'completed',
  snoozed: 'pending',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

const PO_STATUS: Record<string, string> = {
  concept: 'draft',
  purchased: 'ordered',
  received: 'received',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

const RETURN_STATUS: Record<string, string> = {
  concept: 'requested',
  expected: 'approved',
  received: 'received',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  completed: 'processed',
};

function mapInventory(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const onHand = pickNumber(record, ['stock', 'quantityOnHand']) ?? 0;
  const available = pickNumber(record, ['freestock', 'quantityAvailable']) ?? onHand;
  const allocated = pickNumber(record, ['reserved', 'quantityAllocated']) ?? Math.max(0, onHand - available);
  return {
    entity: 'inventory',
    externalId,
    links: {
      productExternalId: pickString(record, ['idproduct']),
      warehouseExternalId: pickString(record, ['idwarehouse']),
      locationExternalId: pickString(record, ['idlocation']),
    },
    values: compact({
      quantityOnHand: onHand,
      quantityAvailable: available,
      quantityAllocated: allocated,
      status: 'available',
      metadata: { picqerProductCode: pickString(record, ['productcode']), source: 'picqer' },
    }),
  };
}

function mapWarehouse(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const name = pickString(record, ['name'], 255);
  if (!name) return null;
  return {
    entity: 'warehouse',
    externalId,
    values: compact({
      name,
      code: pickString(record, ['code', 'idwarehouse'], 50) ?? externalId.slice(0, 50),
      isActive: record.accepts_orders !== false && record.active !== false,
      isDefault: record.priority === 1 || record.default === true,
      priority: pickNumber(record, ['priority']) ?? 0,
      metadata: { source: 'picqer' },
    }),
  };
}

function mapLocation(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const name = pickString(record, ['name', 'remark'], 255) ?? `Location ${externalId}`;
  const code = pickString(record, ['name', 'remark', 'code'], 50) ?? externalId.slice(0, 50);
  return {
    entity: 'location',
    externalId,
    links: {
      warehouseExternalId: pickString(record, ['idwarehouse']),
    },
    values: compact({
      name,
      code,
      barcode: pickString(record, ['barcode'], 100),
      locationType: record.type === 'bulk' ? 'bulk' : 'storage',
      isActive: record.active !== false,
      metadata: { source: 'picqer' },
    }),
  };
}

function mapPicklist(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const number = pickString(record, ['picklistid', 'id'], 50) ?? externalId;
  const status = PICKLIST_STATUS[pickString(record, ['status']) ?? ''] ?? 'pending';
  const products = Array.isArray(record.products) ? (record.products as unknown[]) : [];
  return {
    entity: 'picklist',
    externalId,
    links: {
      warehouseExternalId: pickString(record, ['idwarehouse']),
      orderExternalId: pickString(record, ['idorder']),
    },
    values: compact({
      pickListNumber: number,
      status,
      priority: record.urgent === true ? 'urgent' : 'normal',
      assignedToName: pickString(record, ['assigned_to_name', 'picker'], 255),
      totalItems: products.length,
      totalQuantity: products.reduce<number>((sum, item) => {
        if (!item || typeof item !== 'object') return sum;
        return sum + (pickNumber(item as Record<string, unknown>, ['amount', 'quantity']) ?? 0);
      }, 0),
      orderIds: [],
      orderCount: pickString(record, ['idorder']) ? 1 : 0,
      pickType: 'order',
      completedAt: status === 'completed' ? new Date() : null,
      shippedAt: status === 'completed' ? new Date() : null,
      notes: pickString(record, ['remarks']),
      metadata: { source: 'picqer', idorder: pickString(record, ['idorder']) },
    }),
  };
}

function mapShipment(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const number =
    pickString(record, ['trackingcode', 'shipmentid', 'id'], 50) ?? `PICQER-${externalId}`;
  return {
    entity: 'shipment',
    externalId,
    links: {
      picklistExternalId: pickString(record, ['idpicklist']),
    },
    values: compact({
      shipmentNumber: number,
      status: record.cancelled === true ? 'cancelled' : 'shipped',
      type: 'outbound',
      carrierName: pickString(record, ['provider', 'providername'], 255),
      shippedAt: pickString(record, ['created', 'created_at'])
        ? new Date(pickString(record, ['created', 'created_at'])!)
        : new Date(),
      internalNotes: pickString(record, ['trackingurl']),
      metadata: {
        source: 'picqer',
        trackingcode: pickString(record, ['trackingcode']),
        trackingurl: pickString(record, ['trackingurl']),
      },
    }),
  };
}

function mapSupplier(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const name = pickString(record, ['name'], 255);
  if (!name) return null;
  return {
    entity: 'supplier',
    externalId,
    values: compact({
      name,
      code: pickString(record, ['idsupplier'], 50) ?? externalId.slice(0, 50),
      contactName: pickString(record, ['contactname'], 255),
      email: pickString(record, ['emailaddress', 'email'], 255),
      phone: pickString(record, ['telephone', 'phone'], 50),
      addressLine1: pickString(record, ['address'], 255),
      city: pickString(record, ['city'], 100),
      postalCode: pickString(record, ['zipcode'], 20),
      country: pickString(record, ['country'], 100),
      isActive: true,
      status: 'active',
      notes: pickString(record, ['remarks']),
      metadata: { source: 'picqer' },
    }),
  };
}

function mapPurchaseOrder(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const poNumber = pickString(record, ['purchaseorderid', 'id'], 50) ?? externalId;
  const status = PO_STATUS[pickString(record, ['status']) ?? ''] ?? 'draft';
  const products = Array.isArray(record.products) ? (record.products as unknown[]) : [];
  return {
    entity: 'purchase_order',
    externalId,
    links: {
      supplierExternalId: pickString(record, ['idsupplier']),
      warehouseExternalId: pickString(record, ['idwarehouse']),
    },
    values: compact({
      poNumber,
      supplierName: pickString(record, ['supplier_name', 'supplier'], 255),
      status,
      expectedDate: pickString(record, ['delivery_date'])
        ? new Date(pickString(record, ['delivery_date'])!)
        : null,
      itemCount: products.length,
      totalQuantityOrdered: products.reduce<number>((sum, item) => {
        if (!item || typeof item !== 'object') return sum;
        return sum + (pickNumber(item as Record<string, unknown>, ['amount']) ?? 0);
      }, 0),
      supplierNotes: pickString(record, ['remarks']),
      metadata: { source: 'picqer' },
    }),
  };
}

function mapReturn(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const returnNumber = pickString(record, ['returnid', 'id'], 50) ?? externalId;
  const status = RETURN_STATUS[pickString(record, ['status']) ?? ''] ?? 'requested';
  const products = Array.isArray(record.products) ? (record.products as Array<Record<string, unknown>>) : [];
  return {
    entity: 'return',
    externalId,
    links: {
      orderExternalId: pickString(record, ['idorder']),
    },
    values: compact({
      returnNumber,
      status,
      customerName: pickString(record, ['name', 'customer_name'], 255),
      customerEmail: pickString(record, ['emailaddress', 'email'], 255),
      reason: pickString(record, ['reason'], 100),
      reasonDetails: pickString(record, ['remarks']),
      items: products.map((p) => ({
        productName: pickString(p, ['name']) ?? 'Item',
        sku: pickString(p, ['productcode']) ?? undefined,
        quantity: pickNumber(p, ['amount', 'quantity']) ?? 1,
      })),
      metadata: { source: 'picqer' },
    }),
  };
}

function mapStockCount(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  return {
    entity: 'stock_count',
    externalId,
    links: {
      warehouseExternalId: pickString(record, ['idwarehouse']),
      locationExternalId: pickString(record, ['idlocation']),
    },
    values: compact({
      countNumber: pickString(record, ['idlocation_stock_count', 'id'], 50) ?? externalId,
      status: pickString(record, ['status']) === 'completed' ? 'completed' : 'in_progress',
      completedAt: pickString(record, ['completed_at', 'updated_at'])
        ? new Date(pickString(record, ['completed_at', 'updated_at'])!)
        : null,
      locationIds: pickString(record, ['idlocation']) ? [pickString(record, ['idlocation'])!] : [],
      metadata: { source: 'picqer' },
    }),
  };
}

function mapInventoryMovement(record: Record<string, unknown>, externalId: string): MappedWmsEntity | null {
  const amount = pickNumber(record, ['amount', 'quantity']) ?? 0;
  return {
    entity: 'inventory_movement',
    externalId,
    links: {
      productExternalId: pickString(record, ['idproduct']),
      warehouseExternalId: pickString(record, ['idwarehouse', 'idwarehouse_from']),
    },
    values: compact({
      movementNumber: pickString(record, ['idmovement', 'id'], 50) ?? externalId,
      movementType: 'transfer',
      status: 'completed',
      quantity: Math.abs(amount) || 1,
      sku: pickString(record, ['productcode'], 100),
      name: pickString(record, ['name'], 255),
      sourceWarehouseId: null,
      destWarehouseId: null,
      completedAt: pickString(record, ['created', 'created_at'])
        ? new Date(pickString(record, ['created', 'created_at'])!)
        : new Date(),
      notes: pickString(record, ['reason', 'remarks']),
      metadata: {
        source: 'picqer',
        idwarehouse_from: pickString(record, ['idwarehouse_from']),
        idwarehouse_to: pickString(record, ['idwarehouse_to', 'idwarehouse']),
      },
    }),
  };
}
