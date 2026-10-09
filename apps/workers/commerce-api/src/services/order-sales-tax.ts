/**
 * Order sales tax: the WeldBooks sales tax engine (docs/plans/weldbooks-us.md
 * §3, phase 6) applied to WeldCommerce orders and carts.
 *
 * An order has no accounting entity, so the workspace's default entity decides:
 * `settings.defaultEntityId`, else the entity flagged `isDefault`, else the only
 * entity. The engine runs only when that entity's jurisdiction does sales tax
 * (the US); otherwise the result is `{ supported: false }` and the order's tax
 * is left as it is.
 *
 * Rules shared with WeldBooks: tax is charged only where the entity is
 * registered, an exemption certificate zeroes it, and an engine failure never
 * becomes zero tax. A failure throws `OrderSalesTaxError` (503) and callers
 * keep whatever the order held before.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { decryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { normalizePostalAddress, type PostalAddress } from '@weldsuite/books-domain/accounting-address';
import { getJurisdictionFeatures } from '@weldsuite/books-domain/jurisdictions/registry';
import {
  DEFAULT_WELD_TAX_CODE,
  isAvalaraTaxCode,
  isStripeTaxCode,
  isWeldTaxCode,
} from '@weldsuite/books-domain/jurisdictions/us/tax-codes';
import {
  SalesTaxEngineError,
  allocateCents,
  fromCents,
  toCents,
  type JurisdictionLevel,
  type SalesTaxRequest,
  type SalesTaxRequestLine,
  type SalesTaxResult,
  type TaxUse,
} from '@weldsuite/books-domain/sales-tax';
import { loadCustomerCertificates, loadSalesTaxContext } from '@weldsuite/books-domain/sales-tax/load';
import type { Env } from '../types';

/** The shipping charge is a tax line of its own (tax code `shipping`); no document line may use this id. */
export const SHIPPING_LINE_ID = 'shipping';
/** The whole order as one line, when an order has a subtotal but no line items. */
export const ORDER_LINE_ID = 'order';
/** Avalara wants a customer code on every document; anonymous carts share this one. */
const GUEST_CUSTOMER_CODE = 'guest';

export type OrderTaxEnv = Pick<Env, 'DATABASE_ENCRYPTION_KEY' | 'DATABASE_ENCRYPTION_KEY_V2'>;

/** An engine failure or an unusable request. `status` is the HTTP status a route answers with. */
export class OrderSalesTaxError extends Error {
  constructor(
    readonly code: 'TAX_ENGINE_UNAVAILABLE' | 'TAX_REQUEST_INVALID',
    readonly status: 503 | 422,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrderSalesTaxError';
  }
}

function requestInvalid(message: string): OrderSalesTaxError {
  return new OrderSalesTaxError('TAX_REQUEST_INVALID', 422, message);
}

/** Provider rejections of the request (an address it can't place) are the caller's to fix; the rest is the engine being unavailable. */
function toOrderTaxError(err: unknown): unknown {
  if (!(err instanceof SalesTaxEngineError)) return err;
  if (err.code === 'invalid_request') {
    return new OrderSalesTaxError('TAX_REQUEST_INVALID', 422, err.message, { reason: err.code });
  }
  return new OrderSalesTaxError('TAX_ENGINE_UNAVAILABLE', 503, err.message, {
    reason: err.code,
    retryable: err.retryable || err.code === 'unreachable' || err.code === 'rate_limited',
  });
}

// ---------------------------------------------------------------------------
// Input and result
// ---------------------------------------------------------------------------

export interface OrderTaxLineInput {
  lineId: string;
  productId?: string | null;
  /** Line amount net of seller discounts (quantity × price − discount). */
  amount: number;
  quantity: number;
  /** A WeldBooks tax code (or a provider code); else the product's `taxClass`, else `general`. */
  taxCode?: string | null;
  taxIncluded?: boolean;
}

export interface OrderSalesTaxInput {
  /** The stored order this calculation is for, when there is one. */
  orderId?: string;
  lines: OrderTaxLineInput[];
  shippingAmount?: number;
  shipTo?: Record<string, unknown> | null;
  /** Used for the tax address when the ship-to has no state. */
  billTo?: Record<string, unknown> | null;
  /** `parties.id` of the buyer; its exemption certificates and tax use apply. */
  customerPartyId?: string | null;
  /** Overrides the buyer's default (`parties.taxUse`, else company = business, person = personal). */
  customerUse?: TaxUse;
  /** Tax point, YYYY-MM-DD. Default today (UTC). */
  date?: string;
  currency: string;
  /** A marketplace facilitator collects the tax: none is charged, the sale still counts for nexus. */
  marketplaceFacilitated?: boolean;
  /** The order carries the legacy "tax exempt" flag; without a certificate that is only a warning. */
  taxExempt?: boolean;
  /** Warnings the caller already knows (an order with no line items). */
  extraWarnings?: string[];
}

export interface OrderTaxJurisdiction {
  code: string;
  name: string;
  level: JurisdictionLevel;
  stateCode: string;
  agencyId?: string;
  /** Percent, e.g. 6.25. */
  rate: number;
  taxableAmount: number;
  tax: number;
}

export interface OrderTaxLineResult {
  lineId: string;
  taxCode: string;
  tax: number;
  /** Combined percent of the jurisdictions that taxed the line; 0 when nothing was taxed. */
  rate: number;
  taxableAmount: number;
  exemptAmount: number;
  nonTaxableAmount: number;
  details: Array<OrderTaxJurisdiction & { exemptReason?: string; certificateId?: string }>;
}

export interface OrderSalesTaxUnsupported {
  supported: false;
  /** `no_accounting_entity`: the workspace has no default entity. `sales_tax_not_supported`: its jurisdiction has no sales tax. */
  reason: 'no_accounting_entity' | 'sales_tax_not_supported';
  entityId?: string;
}

export interface OrderSalesTaxCalculated {
  supported: true;
  entityId: string;
  engine: string;
  engineRef?: string;
  calculatedAt: string;
  documentDate: string;
  currency: string;
  sourcing: SalesTaxResult['sourcing'];
  shipToState?: string;
  shipToPostalCode?: string;
  totalTax: number;
  /** The part of `totalTax` charged on shipping. */
  shippingTax: number;
  lines: OrderTaxLineResult[];
  /** Tax per jurisdiction over the whole order. */
  jurisdictions: OrderTaxJurisdiction[];
  warnings: string[];
}

export type OrderSalesTaxResult = OrderSalesTaxUnsupported | OrderSalesTaxCalculated;

// ---------------------------------------------------------------------------
// Tax codes
// ---------------------------------------------------------------------------

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function acceptedTaxCode(code: string): boolean {
  return isWeldTaxCode(code) || isStripeTaxCode(code) || isAvalaraTaxCode(code);
}

/**
 * The tax code of a line: its own, else the product's (`taxable = false` is
 * `non_taxable`, else `taxClass`), else `general`. A product's `taxClass` may
 * be a legacy word that is no tax code; it falls back to `general`. A code
 * typed on the line itself that no engine knows is an error rather than a guess.
 */
export function resolveLineTaxCode(
  lineCode: string | null | undefined,
  product?: { taxable: boolean | null; taxClass: string | null } | null,
): string {
  const explicit = text(lineCode);
  if (explicit) {
    if (!acceptedTaxCode(explicit)) throw requestInvalid(`Unknown tax code "${explicit}"`);
    return explicit;
  }
  if (product) {
    if (product.taxable === false) return 'non_taxable';
    const taxClass = text(product.taxClass);
    if (taxClass && acceptedTaxCode(taxClass)) return taxClass;
  }
  return DEFAULT_WELD_TAX_CODE;
}

// ---------------------------------------------------------------------------
// Entity and customer
// ---------------------------------------------------------------------------

interface TaxEntity {
  id: string;
  jurisdictionCode: string;
  salesTaxEngine: string | null;
  address: PostalAddress | null;
}

const entityColumns = {
  id: schema.entities.id,
  jurisdictionCode: schema.entities.jurisdictionCode,
  salesTaxEngine: schema.entities.salesTaxEngine,
  address: schema.entities.address,
};

/** The WeldBooks entity orders are taxed under: the workspace default, else the one flagged default, else the only one. */
export async function resolveOrderTaxEntity(db: Database): Promise<TaxEntity | null> {
  const live = isNull(schema.entities.deletedAt);
  const toEntity = (row: { id: string; jurisdictionCode: string; salesTaxEngine: string | null; address: unknown }): TaxEntity => ({
    id: row.id,
    jurisdictionCode: row.jurisdictionCode,
    salesTaxEngine: row.salesTaxEngine,
    address: normalizePostalAddress(row.address as Record<string, unknown> | null),
  });

  const [settings] = await db.select({ defaultEntityId: schema.settings.defaultEntityId }).from(schema.settings).limit(1);
  if (settings?.defaultEntityId) {
    const [row] = await db
      .select(entityColumns)
      .from(schema.entities)
      .where(and(eq(schema.entities.id, settings.defaultEntityId), live))
      .limit(1);
    if (row) return toEntity(row);
  }

  const [flagged] = await db
    .select(entityColumns)
    .from(schema.entities)
    .where(and(eq(schema.entities.isDefault, true), eq(schema.entities.isActive, true), live))
    .limit(1);
  if (flagged) return toEntity(flagged);

  const rows = await db.select(entityColumns).from(schema.entities).where(live).limit(2);
  return rows.length === 1 ? toEntity(rows[0]) : null;
}

async function loadCustomer(db: Database, entityId: string, partyId: string | null | undefined) {
  const guest = { partyId: GUEST_CUSTOMER_CODE, kind: null as string | null, taxUse: null as string | null, certificates: [] };
  if (!partyId) return guest;
  const [party] = await db
    .select({ id: schema.parties.id, kind: schema.parties.kind, taxUse: schema.parties.taxUse })
    .from(schema.parties)
    .where(and(eq(schema.parties.id, partyId), isNull(schema.parties.deletedAt)))
    .limit(1);
  // A legacy customer id that is no party has no certificates to find.
  if (!party) return guest;
  return {
    partyId: party.id,
    kind: party.kind,
    taxUse: party.taxUse,
    certificates: await loadCustomerCertificates(db, entityId, party.id),
  };
}

/** `parties.taxUse`, else a company buys for business and a person for personal use; an anonymous buyer is a consumer. */
function defaultTaxUse(taxUse: string | null, kind: string | null): TaxUse {
  if (taxUse === 'business' || taxUse === 'personal') return taxUse;
  return kind === 'company' ? 'business' : 'personal';
}

/** The address the sale is taxed at: the ship-to, else the bill-to when the ship-to has no state. */
function taxAddress(shipTo: PostalAddress | null, billTo: PostalAddress | null): PostalAddress | null {
  if (shipTo?.state) return shipTo;
  if (billTo?.state) return billTo;
  return shipTo ?? billTo;
}

function isoDay(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

interface JurisdictionTotals extends Omit<OrderTaxJurisdiction, 'taxableAmount' | 'tax'> {
  taxableCents: number;
  taxCents: number;
}

function jurisdictionKey(d: { agencyId?: string; stateCode: string; level: string; code: string; rate: number }): string {
  return `${d.agencyId ?? ''}|${d.stateCode}|${d.level}|${d.code}|${d.rate}`;
}

export interface OrderTaxDeps {
  /** Injected for tests; the engines default to the global fetch. */
  fetch?: typeof fetch;
}

export async function calculateOrderSalesTax(
  db: Database,
  env: OrderTaxEnv,
  input: OrderSalesTaxInput,
  deps: OrderTaxDeps = {},
): Promise<OrderSalesTaxResult> {
  const entity = await resolveOrderTaxEntity(db);
  if (!entity) return { supported: false, reason: 'no_accounting_entity' };
  if (!getJurisdictionFeatures(entity.jurisdictionCode).salesTax) {
    return { supported: false, reason: 'sales_tax_not_supported', entityId: entity.id };
  }

  const ids = new Set<string>([SHIPPING_LINE_ID]);
  for (const line of input.lines) {
    if (ids.has(line.lineId)) throw requestInvalid(`Line id "${line.lineId}" is used twice or is reserved`);
    ids.add(line.lineId);
  }

  const productIds = [...new Set(input.lines.map((l) => l.productId).filter((id): id is string => Boolean(id)))];
  const products = productIds.length
    ? await db
        .select({ id: schema.products.id, taxable: schema.products.taxable, taxClass: schema.products.taxClass })
        .from(schema.products)
        .where(inArray(schema.products.id, productIds))
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  const codes = new Map<string, string>();
  for (const line of input.lines) {
    codes.set(line.lineId, resolveLineTaxCode(line.taxCode, line.productId ? productById.get(line.productId) : null));
  }
  const shippingCents = toCents(input.shippingAmount ?? 0);
  if (shippingCents > 0) codes.set(SHIPPING_LINE_ID, 'shipping');

  const customer = await loadCustomer(db, entity.id, input.customerPartyId);
  const use = input.customerUse ?? defaultTaxUse(customer.taxUse, customer.kind);
  const shipTo = taxAddress(normalizePostalAddress(input.shipTo), normalizePostalAddress(input.billTo));
  const documentDate = input.date ?? new Date().toISOString().slice(0, 10);
  const currency = input.currency.toUpperCase();

  // A line with nothing to tax needs no engine call (a provider refuses an empty document).
  const sent: SalesTaxRequestLine[] = [
    ...input.lines
      .filter((l) => toCents(l.amount) > 0)
      .map((l) => ({
        lineId: l.lineId,
        amount: fromCents(toCents(l.amount)),
        quantity: l.quantity > 0 ? l.quantity : 1,
        taxCode: codes.get(l.lineId) ?? DEFAULT_WELD_TAX_CODE,
        use,
        ...(l.taxIncluded ? { taxIncluded: true } : {}),
      })),
    ...(shippingCents > 0
      ? [{ lineId: SHIPPING_LINE_ID, amount: fromCents(shippingCents), quantity: 1, taxCode: 'shipping', use }]
      : []),
  ];

  let engineResult: SalesTaxResult | null = null;
  let engineId = entity.salesTaxEngine ?? 'manual';
  if (sent.length > 0) {
    try {
      const ctx = await loadSalesTaxContext(db, entity.id, {
        decrypt: (blob) => decryptField(blob, keyringFromEnv(env)),
        fetch: deps.fetch,
      });
      engineId = ctx.engineId;
      const request: SalesTaxRequest = {
        entityId: entity.id,
        documentType: 'order',
        ...(input.orderId ? { documentId: input.orderId } : {}),
        documentDate,
        currency,
        shipFrom: entity.address ?? {},
        shipTo,
        customer: { partyId: customer.partyId, certificates: customer.certificates, use },
        registrations: ctx.registrations,
        lines: sent,
        ...(input.marketplaceFacilitated ? { marketplaceFacilitated: true } : {}),
      };
      engineResult = await ctx.engine.calculate(request);
    } catch (err) {
      throw toOrderTaxError(err);
    }
  }

  const resultLines = new Map((engineResult?.lines ?? []).map((l) => [l.lineId, l]));
  const totals = new Map<string, JurisdictionTotals>();
  const lineResult = (lineId: string): OrderTaxLineResult => {
    const found = resultLines.get(lineId);
    const details: OrderTaxLineResult['details'] = (found?.details ?? []).map((d) => ({
      code: d.jurisdictionCode,
      name: d.jurisdictionName,
      level: d.level,
      stateCode: d.stateCode,
      ...(d.agencyId ? { agencyId: d.agencyId } : {}),
      rate: d.rate,
      taxableAmount: d.taxableAmount,
      tax: d.tax,
      ...(d.exemptReason ? { exemptReason: String(d.exemptReason) } : {}),
      ...(d.certificateId ? { certificateId: d.certificateId } : {}),
    }));
    for (const d of details) {
      const key = jurisdictionKey(d);
      const acc =
        totals.get(key) ??
        ({ code: d.code, name: d.name, level: d.level, stateCode: d.stateCode, agencyId: d.agencyId, rate: d.rate, taxableCents: 0, taxCents: 0 } satisfies JurisdictionTotals);
      acc.taxableCents += toCents(d.taxableAmount);
      acc.taxCents += toCents(d.tax);
      totals.set(key, acc);
    }
    return {
      lineId,
      taxCode: codes.get(lineId) ?? DEFAULT_WELD_TAX_CODE,
      tax: found?.tax ?? 0,
      rate: round4(details.filter((d) => d.taxableAmount > 0).reduce((sum, d) => sum + d.rate, 0)),
      taxableAmount: found?.taxableAmount ?? 0,
      exemptAmount: found?.exemptAmount ?? 0,
      nonTaxableAmount: found?.nonTaxableAmount ?? 0,
      details,
    };
  };

  const lines = input.lines.map((l) => lineResult(l.lineId));
  if (shippingCents > 0) lines.push(lineResult(SHIPPING_LINE_ID));

  const jurisdictions: OrderTaxJurisdiction[] = [...totals.values()]
    .filter((t) => t.taxCents !== 0 || t.taxableCents !== 0)
    .map(({ taxableCents, taxCents, ...rest }) => {
      const jurisdiction: OrderTaxJurisdiction = {
        code: rest.code,
        name: rest.name,
        level: rest.level,
        stateCode: rest.stateCode,
        ...(rest.agencyId ? { agencyId: rest.agencyId } : {}),
        rate: rest.rate,
        taxableAmount: fromCents(taxableCents),
        tax: fromCents(taxCents),
      };
      return jurisdiction;
    });

  const warnings = new Set<string>([...(engineResult?.warnings ?? []).map(String), ...(input.extraWarnings ?? [])]);
  if (input.taxExempt && !lines.some((l) => l.exemptAmount > 0)) {
    warnings.add('tax_exempt_flag_without_certificate');
  }

  const totalTax = fromCents(lines.reduce((sum, l) => sum + toCents(l.tax), 0));
  return {
    supported: true,
    entityId: entity.id,
    engine: engineResult?.engine ?? engineId,
    ...(engineResult?.engineRef ? { engineRef: engineResult.engineRef } : {}),
    calculatedAt: engineResult?.calculatedAt ?? new Date().toISOString(),
    documentDate,
    currency,
    sourcing: engineResult?.sourcing ?? 'none',
    ...(engineResult?.shipToState ? { shipToState: engineResult.shipToState } : {}),
    ...(engineResult?.shipToPostalCode ? { shipToPostalCode: engineResult.shipToPostalCode } : {}),
    totalTax,
    shippingTax: lines.find((l) => l.lineId === SHIPPING_LINE_ID)?.tax ?? 0,
    lines,
    jurisdictions,
    warnings: [...warnings],
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** What tax needs of an order: a stored row, or the body of an order being created. */
export interface OrderTaxSubject {
  id?: string;
  currency?: string | null;
  subtotal?: string | number | null;
  discountTotal?: string | number | null;
  shippingTotal?: string | number | null;
  taxTotal?: string | number | null;
  total?: string | number | null;
  taxExempt?: number | boolean | null;
  counterpartyId?: string | null;
  customerId?: string | null;
  billingAddress?: unknown;
  shippingAddress?: unknown;
  createdAt?: Date | string | null;
  metadata?: unknown;
}

export interface OrderTaxItem {
  id: string;
  productId: string | null;
  quantity: number;
  unitPrice: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
}

function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export interface OrderTaxOptions {
  date?: string;
  customerUse?: TaxUse;
  marketplaceFacilitated?: boolean;
}

/**
 * The tax request of an order. A line is the item's price × quantity less its
 * own discount, less its share of any order-level discount the items don't
 * already carry (a coupon), since a seller's discount lowers the taxable price.
 * An order with a subtotal but no items (the order form types totals only) is
 * taxed as one line of general goods, with a `no_line_items` warning.
 */
export function taxInputFromOrder(
  order: OrderTaxSubject,
  items: OrderTaxItem[],
  options: OrderTaxOptions = {},
): OrderSalesTaxInput {
  const gross = items.map((item) => {
    const quantity = item.quantity > 0 ? item.quantity : 1;
    const own = toCents(money(item.discountAmount));
    return { item, quantity, cents: Math.max(0, toCents(money(item.unitPrice) * quantity) - own), own };
  });

  const itemDiscounts = gross.reduce((sum, g) => sum + g.own, 0);
  const orderDiscount = Math.max(0, toCents(money(order.discountTotal)) - itemDiscounts);
  const base = gross.reduce((sum, g) => sum + g.cents, 0);
  const shares = orderDiscount > 0 && base > 0 ? allocateCents(Math.min(orderDiscount, base), gross.map((g) => g.cents)) : [];

  const extraWarnings: string[] = [];
  let lines: OrderTaxLineInput[] = gross.map((g, i) => ({
    lineId: g.item.id,
    productId: g.item.productId,
    amount: fromCents(Math.max(0, g.cents - (shares[i] ?? 0))),
    quantity: g.quantity,
  }));
  if (lines.length === 0 && money(order.subtotal) > 0) {
    lines = [{ lineId: ORDER_LINE_ID, amount: money(order.subtotal), quantity: 1 }];
    extraWarnings.push('no_line_items');
  }

  return {
    ...(order.id ? { orderId: order.id } : {}),
    lines,
    shippingAmount: money(order.shippingTotal),
    shipTo: asRecord(order.shippingAddress),
    billTo: asRecord(order.billingAddress),
    customerPartyId: order.counterpartyId ?? order.customerId ?? null,
    ...(options.customerUse ? { customerUse: options.customerUse } : {}),
    date: options.date ?? isoDay(order.createdAt),
    currency: order.currency || 'USD',
    ...(options.marketplaceFacilitated ? { marketplaceFacilitated: true } : {}),
    taxExempt: Boolean(order.taxExempt),
    extraWarnings,
  };
}

/** What a calculation changes on an order. */
export interface OrderTaxApplication {
  order: {
    taxLines: Array<{ title: string; rate: number; price: string }>;
    taxTotal: string;
    total: string;
    metadata: Record<string, unknown>;
  };
  /** Only the items whose tax changed. */
  items: Array<{ id: string; taxAmount: string }>;
}

/**
 * The order columns a calculation writes. `taxLines` holds one entry per
 * jurisdiction and rate (rate in percent). The new total moves by the change
 * in tax only, whatever convention the order used for subtotal and discounts;
 * an order with no total yet gets subtotal − discounts + shipping + tax. The
 * jurisdiction detail of every line, the engine and its warnings go to
 * `metadata.salesTax`, which a later invoice can read.
 */
export function buildOrderTaxApplication(
  order: OrderTaxSubject,
  items: OrderTaxItem[],
  result: OrderSalesTaxCalculated,
): OrderTaxApplication {
  const taxCents = toCents(result.totalTax);
  const hasTotal = order.total !== null && order.total !== undefined && order.total !== '';
  const totalCents = hasTotal
    ? toCents(money(order.total)) - toCents(money(order.taxTotal)) + taxCents
    : toCents(money(order.subtotal)) - toCents(money(order.discountTotal)) + toCents(money(order.shippingTotal)) + taxCents;

  const changed = items.flatMap((item) => {
    const tax = result.lines.find((l) => l.lineId === item.id)?.tax ?? 0;
    return toCents(money(item.taxAmount)) === toCents(tax) ? [] : [{ id: item.id, taxAmount: tax.toFixed(2) }];
  });

  return {
    order: {
      taxLines: result.jurisdictions
        .filter((j) => toCents(j.tax) !== 0)
        .map((j) => ({ title: j.name, rate: j.rate, price: j.tax.toFixed(2) })),
      taxTotal: fromCents(taxCents).toFixed(2),
      total: fromCents(totalCents).toFixed(2),
      metadata: {
        ...(asRecord(order.metadata) ?? {}),
        salesTax: {
          version: 1,
          entityId: result.entityId,
          engine: result.engine,
          ...(result.engineRef ? { engineRef: result.engineRef } : {}),
          calculatedAt: result.calculatedAt,
          documentDate: result.documentDate,
          currency: result.currency,
          sourcing: result.sourcing,
          ...(result.shipToState ? { shipToState: result.shipToState } : {}),
          ...(result.shipToPostalCode ? { shipToPostalCode: result.shipToPostalCode } : {}),
          totalTax: result.totalTax,
          shippingTax: result.shippingTax,
          warnings: result.warnings,
          jurisdictions: result.jurisdictions,
          lines: result.lines,
        },
      },
    },
    items: changed,
  };
}

/** The item updates of an application, for one `atomically` batch with the order update. */
export function orderItemTaxStatements(handle: Database, application: OrderTaxApplication): unknown[] {
  return application.items.map((item) =>
    handle.update(schema.orderItems).set({ taxAmount: item.taxAmount }).where(eq(schema.orderItems.id, item.id)),
  );
}

/** Writes an application: the order columns and its items' tax, together or not at all. */
export async function persistOrderTax(db: Database, orderId: string, application: OrderTaxApplication): Promise<void> {
  await atomically(db, (h) => [
    h
      .update(schema.orders)
      .set({ ...application.order, updatedAt: new Date() })
      .where(and(eq(schema.orders.id, orderId), isNull(schema.orders.deletedAt))),
    ...orderItemTaxStatements(h, application),
  ]);
}

export async function loadOrderTaxItems(db: Database, orderId: string): Promise<OrderTaxItem[]> {
  return db
    .select({
      id: schema.orderItems.id,
      productId: schema.orderItems.productId,
      quantity: schema.orderItems.quantity,
      unitPrice: schema.orderItems.unitPrice,
      discountAmount: schema.orderItems.discountAmount,
      taxAmount: schema.orderItems.taxAmount,
    })
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, orderId))
    .orderBy(schema.orderItems.id);
}

/** Calculates the tax of an order (stored or about to be) and, when the engine ran, what applying it would write. */
export async function calculateOrderTax(
  db: Database,
  env: OrderTaxEnv,
  order: OrderTaxSubject,
  items: OrderTaxItem[],
  options: OrderTaxOptions = {},
  deps: OrderTaxDeps = {},
): Promise<{ result: OrderSalesTaxResult; application?: OrderTaxApplication }> {
  const result = await calculateOrderSalesTax(db, env, taxInputFromOrder(order, items, options), deps);
  if (!result.supported) return { result };
  return { result, application: buildOrderTaxApplication(order, items, result) };
}

const PAID_STATUSES = new Set(['paid', 'partially_refunded', 'refunded']);

/** Why an order's tax can no longer be rewritten, or null. Paid and cancelled orders are frozen like a posted document. */
export function orderTaxLockReason(order: {
  paymentStatus?: string | null;
  paidAt?: Date | string | null;
  status?: string | null;
  cancelledAt?: Date | string | null;
}): string | null {
  if (order.paidAt || (order.paymentStatus && PAID_STATUSES.has(order.paymentStatus))) {
    return 'The order is paid; its tax is frozen. Preview the calculation without applying it.';
  }
  if (order.cancelledAt || order.status === 'cancelled') {
    return 'The order is cancelled; its tax is frozen.';
  }
  return null;
}

/** The calculation as an API answers it: the per-line jurisdiction detail stays on the order's metadata. */
export function toTaxResponse(result: OrderSalesTaxResult): Record<string, unknown> {
  if (!result.supported) return { ...result };
  return {
    ...result,
    lines: result.lines.map(({ details: _details, ...line }) => line),
  };
}
