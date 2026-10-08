/**
 * US invoice labels, paper, date and money formatting.
 *
 * Federal law prescribes nothing for an invoice. The conventions here are what
 * US buyers expect: Letter paper, MM/DD/YYYY, "Bill to" and "Ship to" (the
 * ship-to address drives the sales tax), the sales tax by state and local
 * jurisdiction, the seller's EIN on business invoices, and the reason and
 * certificate number on an exempt sale.
 */

import type { ExemptReason } from '../../sales-tax/types';
import type { InvoiceLabels, InvoiceRequirements } from '../types';

const enLabels: InvoiceLabels = {
  invoice: 'Invoice',
  creditNote: 'Credit memo',
  invoiceNumber: 'Invoice number',
  date: 'Date',
  dueDate: 'Due date',
  from: 'From',
  billTo: 'Bill to',
  shipTo: 'Ship to',
  description: 'Description',
  quantity: 'Quantity',
  unitPrice: 'Unit price',
  tax: 'Sales tax',
  amount: 'Amount',
  subtotal: 'Subtotal',
  discount: 'Discount',
  taxTotal: 'Total sales tax',
  total: 'Total',
  amountPaid: 'Amount paid',
  balanceDue: 'Balance due',
  paymentInstructions: 'Payment instructions',
  vatNumberLabel: 'EIN',
  registrationLabel: 'State tax ID',
};

/** US Letter, 8.5 x 11 inches. PDFs for US entities use it instead of A4. */
export const US_PAPER = {
  size: 'letter',
  widthIn: 8.5,
  heightIn: 11,
  widthPt: 612,
  heightPt: 792,
} as const;

export const US_DATE_FORMAT = 'MM/DD/YYYY';

/** Payment terms a US invoice offers; `days` is the number of days after the invoice date. */
export const US_PAYMENT_TERMS: ReadonlyArray<{ code: string; days: number; label: string }> = [
  { code: 'due_on_receipt', days: 0, label: 'Due on receipt' },
  { code: 'net_10', days: 10, label: 'Net 10' },
  { code: 'net_15', days: 15, label: 'Net 15' },
  { code: 'net_30', days: 30, label: 'Net 30' },
  { code: 'net_45', days: 45, label: 'Net 45' },
  { code: 'net_60', days: 60, label: 'Net 60' },
  { code: 'net_90', days: 90, label: 'Net 90' },
];

/** The terms sentence printed on an invoice. */
export function usPaymentTermsText(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return 'Payment is due upon receipt.';
  const whole = Math.round(days);
  return `Payment is due within ${whole} days of the invoice date (Net ${whole}).`;
}

const EXEMPT_REASON_LABELS: Record<ExemptReason, string> = {
  resale: 'Resale',
  nonprofit: 'Nonprofit organization',
  government: 'Government entity',
  manufacturing: 'Manufacturing',
  agricultural: 'Agricultural',
  other: 'Exempt purchaser',
};

/** The line printed on an invoice whose tax was zeroed by an exemption certificate. */
export function formatExemptSaleNotice(reason: ExemptReason | string, certificateNumber?: string | null): string {
  const label = EXEMPT_REASON_LABELS[reason as ExemptReason] ?? 'Exempt purchaser';
  const certificate = certificateNumber?.trim();
  return certificate
    ? `Exempt sale: ${label}. Certificate no. ${certificate}.`
    : `Exempt sale: ${label}. Exemption certificate on file.`;
}

/** `2026-10-08` (or an ISO timestamp) as `10/08/2026`. Anything that isn't a date comes back unchanged. */
export function formatUsDate(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

/** `10/08/2026` or `1/5/2026` as `YYYY-MM-DD` (month first). Null for anything that isn't a real date. */
export function parseUsDate(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * `$1,234.56`; a negative amount is `-$1,234.56`, or `($1,234.56)` with
 * `parentheses` (the accounting statement style).
 */
export function formatUsMoney(
  amount: number | string,
  opts: { currency?: string; parentheses?: boolean } = {},
): string {
  const value = typeof amount === 'string' ? Number.parseFloat(amount) : amount;
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: opts.currency ?? 'USD',
    currencySign: opts.parentheses ? 'accounting' : 'standard',
  }).format(value);
}

export function getUsInvoiceRequirements(_locale = 'en-US'): InvoiceRequirements {
  return {
    formatInvoiceNumber: (prefix, value, padding) =>
      `${prefix}${String(value).padStart(padding, '0')}`,
    defaultPadding: 4,
    // Nothing is legally required on a US invoice. The EIN is printed when the
    // entity has one; `einOrSsn` can hold an SSN, which is never printed.
    requiredFields: [],
    recommendedFields: ['einOrSsn'],
    labels: enLabels,
  };
}
