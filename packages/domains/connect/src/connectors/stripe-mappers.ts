/**
 * Stripe records → WeldSuite entities.
 *
 * The Stripe client hands over invoices (all lines, `total_tax_amounts` with
 * their tax rates expanded), one balance row per currency, and synthetic
 * "lines" per payout (gross, fee, payout). Amounts arrive in minor units and
 * are converted here. Pure: no database, no fetch.
 */

import { stripeAmountToDecimal, stripeBalanceAccountId, type ConnectorEntity } from '@weldsuite/connectors';
import type { DocumentTaxBreakdownRow, StoredPostalAddress } from '@weldsuite/db/schema';
import type {
  MappedBankAccount,
  MappedBankTransaction,
  MappedDocumentLine,
  MappedInvoice,
  MappedParty,
  MappedRecord,
} from './mappers';

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asRecords(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Json => item !== null) : [];
}

function str(value: unknown, max?: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return max !== undefined ? trimmed.slice(0, max) : trimmed;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  return str(asRecord(value)?.id);
}

function dateFromUnix(value: unknown): Date | null {
  const seconds = num(value);
  return seconds === null ? null : new Date(seconds * 1000);
}

function dateFromIso(value: unknown): Date | null {
  const text = str(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function compact(values: Json): Json {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function money(amountMinor: number, currency: string): string {
  return stripeAmountToDecimal(amountMinor, currency);
}

// ------------------------------------------------------------------ customers

function stripeAddress(source: unknown): StoredPostalAddress | null {
  const address = asRecord(source);
  if (!address) return null;
  const mapped = compact({
    line1: str(address.line1),
    line2: str(address.line2),
    city: str(address.city),
    state: str(address.state),
    postalCode: str(address.postal_code),
    country: str(address.country)?.toUpperCase(),
  });
  return Object.keys(mapped).length > 0 ? (mapped as StoredPostalAddress) : null;
}

/** First tax id (EU VAT preferred), e.g. `NL123456789B01`. */
function primaryTaxId(taxIds: unknown): string | null {
  const ids = asRecords(taxIds);
  const vat = ids.find((row) => row.type === 'eu_vat') ?? ids[0];
  return str(vat?.value, 50);
}

/** The customer as the invoice saw it; becomes the invoice's contact. */
export function stripeCustomerSnapshot(invoice: Json): Json | null {
  const customerId = idOf(invoice.customer);
  if (!customerId) return null;
  return {
    id: customerId,
    object: 'stripe_customer',
    name: invoice.customer_name ?? null,
    email: invoice.customer_email ?? null,
    phone: invoice.customer_phone ?? null,
    address: invoice.customer_address ?? null,
    tax_ids: invoice.customer_tax_ids ?? [],
    tax_exempt: invoice.customer_tax_exempt ?? null,
  };
}

function splitName(name: string): { firstName: string | null; lastName: string | null } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { firstName: name.trim() || null, lastName: null };
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(' ') };
}

/**
 * Stripe has no company/person flag. A customer with a tax id is treated as a
 * company (that is who has a VAT number); everyone else as a person.
 */
export function mapStripeCustomer(record: Json, externalId: string): MappedParty | null {
  const email = str(record.email, 255);
  const name = str(record.name, 255) ?? email;
  if (!name) return null;
  const vatNumber = primaryTaxId(record.tax_ids);
  const address = stripeAddress(record.address);
  const phone = str(record.phone, 50);
  const kind: 'company' | 'person' = vatNumber ? 'company' : 'person';
  const { firstName, lastName } = splitName(name);

  const identity = kind === 'company'
    ? compact({
        name,
        displayName: name,
        email,
        phone,
        vatNumber,
        primaryAddress: address,
        source: 'stripe',
        status: 'active',
        ownerId: null,
      })
    : compact({
        firstName,
        lastName,
        fullName: name,
        displayName: name,
        email,
        directPhone: phone,
        primaryAddress: address,
        source: 'stripe',
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
      displayName: name,
      billingAddress: address,
      status: 'active',
      role: 'none',
    }),
  };
}

// ------------------------------------------------------------------ invoices

interface StripeTaxRateInfo {
  id: string;
  percentage: number;
  name: string;
  country: string | null;
}

/** Tax rates used on the invoice, from the expanded `total_tax_amounts[].tax_rate`. */
function invoiceTaxRates(invoice: Json): Map<string, StripeTaxRateInfo> {
  const rates = new Map<string, StripeTaxRateInfo>();
  for (const row of asRecords(invoice.total_tax_amounts)) {
    const rate = asRecord(row.tax_rate);
    const id = idOf(row.tax_rate);
    if (!id) continue;
    const percentage = num(rate?.effective_percentage) ?? num(rate?.percentage) ?? 0;
    rates.set(id, {
      id,
      percentage,
      name: str(rate?.display_name) ?? `${percentage}%`,
      country: str(rate?.country),
    });
  }
  return rates;
}

/** Stripe's taxability reasons that mean "no VAT charged" and how WeldBooks names them. */
const ZERO_RATE_REASONS = new Set([
  'reverse_charge',
  'not_collecting',
  'not_subject_to_tax',
  'excluded_territory',
  'jurisdiction_unsupported',
  'customer_exempt',
  'product_exempt',
  'vat_exempt',
  'zero_rated',
  'not_supported',
]);

function taxBreakdown(invoice: Json, rates: Map<string, StripeTaxRateInfo>): DocumentTaxBreakdownRow[] {
  const currency = str(invoice.currency) ?? 'eur';
  return asRecords(invoice.total_tax_amounts).map((row) => {
    const id = idOf(row.tax_rate) ?? 'stripe';
    const rate = rates.get(id);
    const reason = str(row.taxability_reason);
    return {
      taxRateId: id,
      taxRateName: rate?.name ?? id,
      taxRate: rate?.percentage ?? 0,
      taxableAmount: Number(money(num(row.taxable_amount) ?? 0, currency)),
      taxAmount: Number(money(num(row.amount) ?? 0, currency)),
      // Country of the rate (OSS: the customer's country), so the Moneybird push picks the matching rate.
      ...(rate?.country ? { jurisdictionCode: rate.country.toUpperCase() } : {}),
      ...(reason ? { taxCategoryCode: reason } : {}),
      ...(reason && ZERO_RATE_REASONS.has(reason) ? { exemptReason: reason } : {}),
    };
  });
}

function linePeriod(line: Json): { from: string; to: string } | null {
  const period = asRecord(line.period);
  const start = dateFromUnix(period?.start);
  const end = dateFromUnix(period?.end);
  if (!start || !end) return null;
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function mapInvoiceLine(line: Json, index: number, currency: string, rates: Map<string, StripeTaxRateInfo>): MappedDocumentLine & {
  period: { from: string; to: string } | null;
} {
  const taxAmounts = asRecords(line.tax_amounts);
  const discounts = sum(asRecords(line.discount_amounts).map((row) => num(row.amount) ?? 0));
  // `taxable_amount` is the line after discounts and excluding tax, for both
  // tax-exclusive and tax-inclusive prices. Without tax lines, fall back to the
  // excluding-tax amount minus discounts.
  const netMinor = taxAmounts.length > 0
    ? num(taxAmounts[0]?.taxable_amount) ?? 0
    : (num(line.amount_excluding_tax) ?? num(line.amount) ?? 0) - discounts;
  const taxMinor = sum(taxAmounts.map((row) => num(row.amount) ?? 0));
  const percentage = taxAmounts.length > 0
    ? sum(taxAmounts.map((row) => rates.get(idOf(row.tax_rate) ?? '')?.percentage ?? 0))
    : null;
  const quantity = num(line.quantity) ?? 1;
  const net = Number(money(netMinor, currency));
  const price = asRecord(line.price);
  const description =
    str(line.description, 2000)
    ?? str(price?.nickname, 2000)
    ?? 'Item';

  return {
    externalProductId: null,
    description,
    quantity: String(quantity || 1),
    unitPrice: (quantity ? net / quantity : net).toFixed(4),
    taxRate: percentage === null ? null : String(percentage),
    taxAmount: money(taxMinor, currency),
    lineTotal: money(netMinor, currency),
    lineTotalWithTax: money(netMinor + taxMinor, currency),
    sortOrder: index,
    period: linePeriod(line),
  };
}

function invoiceStatus(invoice: Json, now: Date): string | null {
  const status = str(invoice.status);
  if (status === 'paid') return 'paid';
  if (status === 'void') return 'cancelled';
  if (status === 'uncollectible') return 'uncollectible';
  if (status !== 'open') return null;
  if ((num(invoice.amount_paid) ?? 0) > 0) return 'partial';
  const due = dateFromUnix(invoice.due_date);
  return due && due < now ? 'overdue' : 'sent';
}

/**
 * A finalized Stripe invoice. Drafts and invoices before the connection's
 * start date (`_weld_skip`) map to null and are counted as skipped.
 */
export function mapStripeInvoice(record: Json, externalId: string, now = new Date()): MappedInvoice | null {
  if (record._weld_skip === true) return null;
  const status = invoiceStatus(record, now);
  const number = str(record.number, 50);
  if (!status || !number) return null;

  const currency = (str(record.currency) ?? 'eur').toLowerCase();
  const transitions = asRecord(record.status_transitions);
  const issueDate = dateFromUnix(transitions?.finalized_at) ?? dateFromUnix(record.created) ?? now;
  const dueDate = dateFromUnix(record.due_date) ?? issueDate;
  const paidAt = status === 'paid' ? dateFromUnix(transitions?.paid_at) ?? issueDate : null;
  const rates = invoiceTaxRates(record);
  const lines = asRecords(asRecord(record.lines)?.data).map((line, index) => mapInvoiceLine(line, index, currency, rates));
  const discountMinor = sum(asRecords(record.total_discount_amounts).map((row) => num(row.amount) ?? 0));
  const taxMinor = num(record.tax) ?? sum(asRecords(record.total_tax_amounts).map((row) => num(row.amount) ?? 0));
  const totalMinor = num(record.total) ?? 0;
  const subtotalMinor = num(record.subtotal_excluding_tax) ?? num(record.subtotal) ?? totalMinor - taxMinor;
  const customer = stripeCustomerSnapshot(record);

  return {
    entity: 'invoice',
    externalId,
    contactExternalId: customer ? String(customer.id) : null,
    nestedContact: customer,
    lineItems: lines,
    values: compact({
      invoiceNumber: number,
      type: 'standard',
      status,
      contactName: str(record.customer_name, 255) ?? str(record.customer_email, 255),
      contactEmail: str(record.customer_email, 255),
      contactTaxNumber: primaryTaxId(record.customer_tax_ids),
      billingAddress: stripeAddress(record.customer_address),
      issueDate,
      dueDate,
      paidAt,
      sentAt: issueDate,
      currency: currency.toUpperCase(),
      subtotal: money(subtotalMinor, currency),
      discountTotal: money(discountMinor, currency),
      taxTotal: money(taxMinor, currency),
      total: money(totalMinor, currency),
      amountPaid: money(num(record.amount_paid) ?? 0, currency),
      balanceDue: status === 'cancelled' ? '0.00' : money(num(record.amount_remaining) ?? 0, currency),
      reference: str(record.id, 255),
      notes: str(record.description),
      paymentLink: str(record.hosted_invoice_url, 500),
      taxBreakdown: taxBreakdown(record, rates),
      journalEntryId: null,
    }),
  };
}

// ------------------------------------------------------------------ balance + payouts

export function mapStripeBalance(record: Json, externalId: string): MappedBankAccount | null {
  const currency = str(record.currency)?.toUpperCase();
  if (!currency) return null;
  const balanceMinor = (num(record.available) ?? 0) + (num(record.pending) ?? 0);
  return {
    entity: 'bank_account',
    externalId,
    values: compact({
      name: `Stripe balance (${currency})`,
      currency,
      bankName: 'Stripe',
      currentBalance: money(balanceMinor, currency),
      isActive: true,
      // The balance is not a bank: nothing to reconcile against a statement file.
      autoReconcile: false,
      metadata: { stripeBalance: true, stripeAccountId: str(record.account_id) },
    }),
  };
}

export interface MappedStripeLine extends MappedBankTransaction {
  /** Stripe invoice the charge paid, for reconciliation against the imported invoice. */
  invoiceExternalId: string | null;
}

/** One line of a paid payout: a charge (gross), its fee, other movements, or the payout itself. */
export function mapStripeLine(record: Json, externalId: string): MappedStripeLine | null {
  const currency = (str(record.currency) ?? 'EUR').toUpperCase();
  const amountMinor = num(record.amount);
  const date = dateFromIso(record.created);
  if (amountMinor === null || !date) return null;
  const line = str(record.line) ?? 'gross';
  const type = str(record.type) ?? 'adjustment';
  const reference = str(record.source_id, 255);
  const description =
    str(record.description)
    ?? (line === 'payout' ? `Stripe payout ${str(record.payout_id) ?? ''}`.trim() : `Stripe ${type}`);

  return {
    entity: 'bank_transaction',
    externalId,
    financialAccountExternalId: str(record.balance_account) ?? stripeBalanceAccountId(currency),
    invoiceExternalId: str(record.invoice_id),
    values: compact({
      date,
      valueDate: dateFromIso(record.available_on) ?? date,
      amount: money(amountMinor, currency),
      description,
      counterpartyName: line === 'gross' ? str(record.customer_name, 255) ?? 'Stripe' : 'Stripe',
      reference,
      transactionCode: type.slice(0, 20),
      externalId,
      status: 'unreconciled',
      source: 'import',
      rawData: compact({
        stripeLine: line,
        type,
        payoutId: str(record.payout_id),
        payoutArrivalDate: str(record.payout_arrival_date),
        balanceTransactionId: str(record.balance_transaction_id),
        chargeId: str(record.charge_id),
        invoiceId: str(record.invoice_id),
        sourceId: reference,
        reportingCategory: str(record.reporting_category),
        currency,
      }),
    }),
  };
}

export function mapStripeRecord(entity: ConnectorEntity, record: Json, externalId: string): MappedRecord | null {
  switch (entity) {
    case 'invoice':
      return mapStripeInvoice(record, externalId);
    case 'party':
      return mapStripeCustomer(record, externalId);
    case 'bank_account':
      return mapStripeBalance(record, externalId);
    case 'bank_transaction':
      return mapStripeLine(record, externalId);
    default:
      return null;
  }
}
