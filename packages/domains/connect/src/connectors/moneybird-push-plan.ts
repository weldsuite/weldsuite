/**
 * Pure building blocks of the WeldBooks → Moneybird push: which Moneybird tax
 * rate a line gets, the external sales invoice and contact payloads, and the
 * statement lines for one Stripe payout. No database, no fetch.
 */

import type { MoneybirdTaxRate } from '@weldsuite/connectors';
import type { DocumentTaxBreakdownRow, MoneybirdTaxRateOverrides } from '@weldsuite/db/schema';

// ------------------------------------------------------------------ tax rates

/** Stripe taxability reasons grouped the way Moneybird administrations name their 0% rates. */
const REVERSE_CHARGE_REASONS = new Set(['reverse_charge']);
const OUTSIDE_EU_REASONS = new Set([
  'not_collecting',
  'not_subject_to_tax',
  'excluded_territory',
  'jurisdiction_unsupported',
  'not_supported',
]);
const EXEMPT_REASONS = new Set(['customer_exempt', 'product_exempt', 'vat_exempt', 'zero_rated']);

const REVERSE_CHARGE_NAME = /verlegd|reverse/i;
const OUTSIDE_EU_NAME = /buiten|outside|export|non[- ]?eu|niet[- ]?eu|world|wereld/i;
const EXEMPT_NAME = /vrijgesteld|exempt|geen btw|no vat|0\s?%/i;

export type ZeroRateCategory = 'reverseCharge' | 'outsideEu' | 'exempt' | 'noTax';

export function zeroRateCategory(reason: string | null | undefined): ZeroRateCategory {
  if (!reason) return 'noTax';
  if (REVERSE_CHARGE_REASONS.has(reason)) return 'reverseCharge';
  if (OUTSIDE_EU_REASONS.has(reason)) return 'outsideEu';
  if (EXEMPT_REASONS.has(reason)) return 'exempt';
  return 'exempt';
}

function sameRate(a: number | null, b: number): boolean {
  return a !== null && Math.abs(a - b) < 0.005;
}

function salesRates(rates: MoneybirdTaxRate[]): MoneybirdTaxRate[] {
  return rates.filter((rate) => rate.active && (rate.taxRateType === 'sales_invoice' || rate.taxRateType === null));
}

/**
 * The administration's 0% rate for a category, by name. Reverse charge only
 * ever takes a "verlegd" rate (a plain 0% would miss the ICP return) and
 * nothing else ever takes that one; exempt and untaxed lines prefer a plain 0%.
 */
function zeroRateByName(rates: MoneybirdTaxRate[], category: ZeroRateCategory): MoneybirdTaxRate | null {
  const zero = rates.filter((rate) => sameRate(rate.percentage, 0));
  const isReverse = (rate: MoneybirdTaxRate) => REVERSE_CHARGE_NAME.test(rate.name);
  const isOutside = (rate: MoneybirdTaxRate) => OUTSIDE_EU_NAME.test(rate.name);
  if (category === 'reverseCharge') return zero.find(isReverse) ?? null;
  if (category === 'outsideEu') return zero.find(isOutside) ?? zero.find((rate) => !isReverse(rate)) ?? null;
  const plain = zero.filter((rate) => !isReverse(rate) && !isOutside(rate));
  return plain.find((rate) => EXEMPT_NAME.test(rate.name)) ?? plain[0] ?? zero.find((rate) => !isReverse(rate)) ?? null;
}

const CATEGORY_LABEL: Record<ZeroRateCategory, string> = {
  reverseCharge: 'reverse charge',
  outsideEu: 'outside the EU',
  exempt: 'exempt',
  noTax: 'no VAT',
};

export interface LineTaxInput {
  /** The line's VAT percentage, null when the Stripe invoice had no tax. */
  percentage: number | null;
  breakdown: DocumentTaxBreakdownRow[];
}

export type TaxRateResolution = { taxRateId: string } | { error: string };

/**
 * The Moneybird sales tax rate for one line: an override for the 0% case when
 * the connection set one, else the rate with the same percentage (for OSS,
 * the one whose country matches the Stripe rate's country).
 */
export function resolveMoneybirdTaxRate(
  line: LineTaxInput,
  allRates: MoneybirdTaxRate[],
  overrides: MoneybirdTaxRateOverrides,
): TaxRateResolution {
  const rates = salesRates(allRates);
  const pct = line.percentage;
  const row = pct === null ? undefined : line.breakdown.find((entry) => sameRate(entry.taxRate, pct));

  if (pct !== null && pct > 0) {
    const candidates = rates.filter((rate) => sameRate(rate.percentage, pct));
    const country = row?.jurisdictionCode?.toUpperCase() ?? null;
    const match =
      (country ? candidates.find((rate) => rate.country?.toUpperCase() === country) : undefined)
      ?? candidates.find((rate) => !rate.country)
      ?? candidates[0];
    const where = country ? ' for ' + country : '';
    return match ? { taxRateId: match.id } : { error: `No ${pct}% sales tax rate in Moneybird${where}` };
  }

  // 0%: Stripe says why (reverse charge, outside scope, exempt); no tax line at all is "no tax".
  const category: ZeroRateCategory = pct === null ? 'noTax' : zeroRateCategory(row?.taxCategoryCode);
  const override = overrides[category];
  if (override) return { taxRateId: override };
  const zero = zeroRateByName(rates, category);
  return zero
    ? { taxRateId: zero.id }
    : {
        error: `No Moneybird sales tax rate for ${CATEGORY_LABEL[category]} lines: pick one under tax rates on the Moneybird connection`,
      };
}

// ------------------------------------------------------------------ invoices

export interface PushInvoiceLine {
  description: string;
  quantity: string | null;
  unitPrice: string;
  lineTotal: string | null;
  taxRate: string | null;
  period: { from?: string; to?: string } | null;
}

export interface PushInvoice {
  invoiceNumber: string;
  issueDate: Date;
  dueDate: Date;
  currency: string;
  paymentLink: string | null;
  taxBreakdown: DocumentTaxBreakdownRow[];
  lines: PushInvoiceLine[];
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function moneybirdPeriod(period: PushInvoiceLine['period']): string | undefined {
  if (!period?.from || !period.to) return undefined;
  return `${period.from.replaceAll('-', '')}..${period.to.replaceAll('-', '')}`;
}

/**
 * Whole quantities with a unit price that multiplies out to the line total go
 * over as-is; anything else (proration, discounts) as one unit of the line
 * total, so Moneybird never re-rounds a fractional unit price.
 */
function lineAmountAndPrice(line: PushInvoiceLine): { amount: string; price: string } {
  const totalCents = Math.round(Number(line.lineTotal ?? line.unitPrice) * 100);
  const quantity = Number(line.quantity ?? '1');
  const unitCents = Number(line.unitPrice) * 100;
  const wholeUnit = Math.abs(unitCents - Math.round(unitCents)) < 1e-6;
  if (Number.isInteger(quantity) && quantity > 0 && wholeUnit && Math.round(unitCents) * quantity === totalCents) {
    return { amount: String(quantity), price: (Math.round(unitCents) / 100).toFixed(2) };
  }
  return { amount: '1', price: (totalCents / 100).toFixed(2) };
}

export function buildExternalSalesInvoicePayload(args: {
  invoice: PushInvoice;
  contactId: string;
  revenueLedgerAccountId: string;
  taxRates: MoneybirdTaxRate[];
  overrides: MoneybirdTaxRateOverrides;
}): { payload: Record<string, unknown> } | { error: string } {
  const details: Array<Record<string, unknown>> = [];
  for (const line of args.invoice.lines) {
    const percentage = line.taxRate === null || line.taxRate === '' ? null : Number(line.taxRate);
    const resolved = resolveMoneybirdTaxRate(
      { percentage: percentage !== null && Number.isFinite(percentage) ? percentage : null, breakdown: args.invoice.taxBreakdown },
      args.taxRates,
      args.overrides,
    );
    if ('error' in resolved) return { error: resolved.error };
    const { amount, price } = lineAmountAndPrice(line);
    const period = moneybirdPeriod(line.period);
    details.push({
      description: line.description.slice(0, 2000),
      amount,
      price,
      tax_rate_id: resolved.taxRateId,
      ledger_account_id: args.revenueLedgerAccountId,
      ...(period ? { period } : {}),
    });
  }
  if (details.length === 0) return { error: 'The invoice has no lines' };

  return {
    payload: {
      contact_id: args.contactId,
      reference: args.invoice.invoiceNumber,
      date: ymd(args.invoice.issueDate),
      due_date: ymd(args.invoice.dueDate),
      currency: args.invoice.currency.toUpperCase(),
      prices_are_incl_tax: false,
      source: 'Stripe',
      ...(args.invoice.paymentLink ? { source_url: args.invoice.paymentLink } : {}),
      details_attributes: details,
    },
  };
}

// ------------------------------------------------------------------ contacts

export interface PushContactInput {
  kind: 'company' | 'person';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  vatNumber: string | null;
  address: { line1?: string; line2?: string; city?: string; postalCode?: string; country?: string } | null;
}

export function buildMoneybirdContactPayload(contact: PushContactInput): Record<string, unknown> {
  const address = contact.address ?? {};
  const person = contact.kind === 'person' && (contact.firstName || contact.lastName);
  const payload: Record<string, unknown> = person
    ? { firstname: contact.firstName ?? '', lastname: contact.lastName ?? '' }
    : { company_name: contact.displayName };
  const optional: Record<string, string | null | undefined> = {
    email: contact.email,
    send_invoices_to_email: contact.email,
    phone: contact.phone,
    tax_number: contact.vatNumber,
    address1: address.line1,
    address2: address.line2,
    zipcode: address.postalCode,
    city: address.city,
    country: address.country?.toUpperCase(),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) payload[key] = value;
  }
  return payload;
}

// ------------------------------------------------------------------ payout statements

/** One Stripe line as stored on the WeldBooks "Stripe balance" account. */
export interface PayoutLine {
  bankTransactionId: string;
  stripeLine: 'gross' | 'fee' | 'payout';
  type: string;
  amount: string;
  date: Date;
  description: string | null;
  balanceTransactionId: string | null;
  /** Moneybird external sales invoice this charge paid, when it was pushed. */
  moneybirdInvoiceId: string | null;
  invoiceNumber: string | null;
  counterpartyName: string | null;
}

/** How a statement line gets booked once Moneybird created it. */
export type StatementLineBooking =
  | { kind: 'invoice'; moneybirdInvoiceId: string }
  | { kind: 'fee' }
  | { kind: 'payout' }
  | { kind: 'manual' };

export interface PlannedMutation {
  /** Unique token in the message, to find the created mutation again. */
  token: string;
  date: string;
  message: string;
  amount: string;
  booking: StatementLineBooking;
  /** WeldBooks bank transaction the line stands for (the payout line for the fee total). */
  bankTransactionId: string;
}

function cents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

function fromCents(value: number): string {
  return (value / 100).toFixed(2);
}

const PAYMENT_TYPES = new Set(['charge', 'payment']);

/** A charge (linked to its invoice when that was pushed) or another movement, booked by hand. */
function movementMutation(line: PayoutLine): PlannedMutation {
  const token = line.balanceTransactionId ?? line.bankTransactionId;
  const isPayment = PAYMENT_TYPES.has(line.type);
  const label = isPayment
    ? [line.invoiceNumber, line.counterpartyName].filter(Boolean).join(' ') || 'Stripe payment'
    : line.description ?? `Stripe ${line.type}`;
  return {
    token,
    date: ymd(line.date),
    message: `${label} [${token}]`.slice(0, 255),
    amount: Number(line.amount).toFixed(2),
    booking: isPayment && line.moneybirdInvoiceId
      ? { kind: 'invoice', moneybirdInvoiceId: line.moneybirdInvoiceId }
      : { kind: 'manual' },
    bankTransactionId: line.bankTransactionId,
  };
}

/**
 * Statement lines for one payout: every charge (linked to its invoice when it
 * was pushed), other movements as they are (refunds, adjustments: booked by
 * hand), Stripe's own fees as one total, and the payout to the bank.
 */
export function planPayoutStatement(payoutId: string, lines: PayoutLine[]): PlannedMutation[] {
  const planned: PlannedMutation[] = [];
  let feeCents = 0;
  let feeDate: Date | null = null;
  let payoutLine: PayoutLine | null = null;

  for (const line of lines) {
    if (line.stripeLine === 'payout') {
      payoutLine = line;
      continue;
    }
    if (line.stripeLine === 'fee' || line.type === 'stripe_fee') {
      feeCents += cents(line.amount);
      if (feeDate === null || line.date.getTime() > feeDate.getTime()) feeDate = line.date;
      continue;
    }
    planned.push(movementMutation(line));
  }

  if (feeCents !== 0 && payoutLine) {
    planned.push({
      token: `${payoutId}-fees`,
      date: ymd(feeDate ?? payoutLine.date),
      message: `Stripe fees ${payoutId} [${payoutId}-fees]`,
      amount: fromCents(feeCents),
      booking: { kind: 'fee' },
      bankTransactionId: payoutLine.bankTransactionId,
    });
  }
  if (payoutLine) {
    planned.push({
      token: payoutId,
      date: ymd(payoutLine.date),
      message: `Stripe payout ${payoutId} [${payoutId}]`,
      amount: Number(payoutLine.amount).toFixed(2),
      booking: { kind: 'payout' },
      bankTransactionId: payoutLine.bankTransactionId,
    });
  }
  return planned;
}

/** Find the created mutation for each planned line by the token in its message. */
export function matchCreatedMutations(
  planned: PlannedMutation[],
  created: Array<Record<string, unknown>>,
): Map<string, string> {
  const byToken = new Map<string, string>();
  for (const mutation of created) {
    const message = typeof mutation.message === 'string' ? mutation.message : '';
    const id = mutation.id === undefined || mutation.id === null ? '' : String(mutation.id);
    if (!id) continue;
    const hit = planned.find((line) => message.includes(`[${line.token}]`) && !byToken.has(line.token));
    if (hit) byToken.set(hit.token, id);
  }
  return byToken;
}
