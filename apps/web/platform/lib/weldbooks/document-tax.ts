/**
 * Pure helpers of the document tax UI: the preview request a form's state
 * becomes, the breakdown rows grouped per jurisdiction, and the words for the
 * engine's warnings. None of it calculates tax: the server does (see
 * `weldbooks-sales-tax-preview.ts`).
 */
import { cleanPostalAddress, type PostalAddress } from '@/components/address/postal-address';
import type {
  TaxBreakdownRow,
  TaxDocumentKind,
  TaxJurisdictionLevel,
  TaxPreviewItem,
  TaxPreviewRequest,
  TaxUse,
} from '@/lib/api/domains/weldbooks-sales-tax-preview';

/** Select value for "no VAT rate"; never sent to the API. */
export const NO_TAX_RATE = 'none';

/** `''` = the customer's default use. */
export type TaxUseChoice = '' | TaxUse;

/** A document line as the forms hold it, for every jurisdiction and document kind. */
export interface TaxFormLine {
  description?: string | null;
  quantity: number | string | null | undefined;
  unitPrice: number | string | null | undefined;
  discountPercent?: number | string | null;
  /** VAT / GST rate (NL, IN). */
  taxRateId?: string | null;
  /** US bill: the sales tax percentage the vendor charged on the line. */
  vendorTaxRate?: number | string | null;
  productId?: string | null;
  /** `''` = the product's code, else general goods. */
  taxCode?: string | null;
  taxUse?: TaxUseChoice | null;
  taxIncluded?: boolean | null;
  taxOverrideAmount?: number | string | null;
  taxOverrideReason?: string | null;
  /** US bill: accrue use tax on the line. */
  accrueUseTax?: boolean | null;
  /** Credit memo: the invoice line the line credits. */
  originalLineId?: string | null;
}

export interface TaxPreviewInput {
  kind: TaxDocumentKind;
  /** The entity charges sales tax (a US entity); false for VAT / GST entities. */
  salesTax: boolean;
  contactId?: string | null;
  issueDate?: string | null;
  currency?: string | null;
  billingAddress?: PostalAddress | null;
  /** Already conditional on "ship to a different address". */
  shippingAddress?: PostalAddress | null;
  /** Only when the user picked another origin than the entity's address. */
  shipFromAddress?: PostalAddress | null;
  deliveryAddress?: PostalAddress | null;
  marketplaceFacilitated?: boolean;
  originalInvoiceId?: string | null;
  lines: TaxFormLine[];
}

function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

/** An amount as the API takes it (a string); `fallback` for an empty or invalid value. */
export function amountString(value: number | string | null | undefined, fallback: string): string {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? String(n) : fallback;
}

/** A rate id the API accepts: the "no tax" placeholders mean none. */
export function cleanTaxRateId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return !trimmed || trimmed === NO_TAX_RATE || trimmed === 'null' ? null : trimmed;
}

/**
 * True when a tax override is complete: an amount and a reason. An override
 * with an amount and no reason is a form error and is left out of the preview.
 */
export function hasCompleteOverride(line: Pick<TaxFormLine, 'taxOverrideAmount' | 'taxOverrideReason'>): boolean {
  const amount = line.taxOverrideAmount;
  const hasAmount = amount !== null && amount !== undefined && String(amount).trim() !== '' && Number.isFinite(Number(amount));
  return hasAmount && Boolean(line.taxOverrideReason?.trim());
}

/** What the server needs to know about one line, by document kind and jurisdiction. */
function previewItem(line: TaxFormLine, kind: TaxDocumentKind, salesTax: boolean): TaxPreviewItem {
  const item: TaxPreviewItem = {
    description: line.description?.trim() || undefined,
    quantity: amountString(line.quantity, '1'),
    unitPrice: amountString(line.unitPrice, '0'),
    discountPercent: amountString(line.discountPercent, '0'),
  };

  if (!salesTax) {
    item.taxRateId = cleanTaxRateId(line.taxRateId);
    return item;
  }

  if (kind === 'bill') {
    item.productId = line.productId || null;
    item.taxCode = line.taxCode || null;
    item.accrueUseTax = Boolean(line.accrueUseTax);
    const vendorRate = toNumber(line.vendorTaxRate);
    if (vendorRate > 0) item.taxRate = String(vendorRate);
    return item;
  }

  if (kind === 'credit_memo') {
    // A credit memo's tax follows the invoice it credits, line by line.
    item.originalLineId = line.originalLineId || null;
    return item;
  }

  item.productId = line.productId || null;
  item.taxCode = line.taxCode || null;
  item.taxUse = line.taxUse || null;
  item.taxIncluded = Boolean(line.taxIncluded);
  if (hasCompleteOverride(line)) {
    item.taxOverrideAmount = amountString(line.taxOverrideAmount, '0');
    item.taxOverrideReason = line.taxOverrideReason?.trim() || null;
  }
  return item;
}

/**
 * The `POST /sales-tax/calculate` body of a form's state, or null while there
 * is nothing to calculate (no line has a price yet).
 */
export function buildTaxPreviewRequest(input: TaxPreviewInput): TaxPreviewRequest | null {
  const priced = input.lines.some((line) => toNumber(line.quantity) > 0 && toNumber(line.unitPrice) > 0);
  if (!priced || input.lines.length === 0) return null;

  const request: TaxPreviewRequest = {
    kind: input.kind,
    contactId: input.contactId || null,
    issueDate: input.issueDate || undefined,
    currency: input.currency || undefined,
    billingAddress: cleanPostalAddress(input.billingAddress) ?? null,
    shippingAddress: cleanPostalAddress(input.shippingAddress) ?? null,
    items: input.lines.map((line) => previewItem(line, input.kind, input.salesTax)),
  };

  if (input.salesTax) {
    if (input.kind === 'bill') {
      request.deliveryAddress = cleanPostalAddress(input.deliveryAddress) ?? null;
    } else if (input.kind === 'credit_memo') {
      // The memo reuses the jurisdictions and rates of the invoice it credits; its origin and marketplace flag are the invoice's.
      request.originalInvoiceId = input.originalInvoiceId || null;
    } else {
      request.shipFromAddress = cleanPostalAddress(input.shipFromAddress) ?? null;
      request.marketplaceFacilitated = Boolean(input.marketplaceFacilitated);
    }
  }
  return request;
}

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<TaxJurisdictionLevel, number> = { state: 0, county: 1, city: 2, district: 3 };

/** A document's tax for one jurisdiction (or one VAT rate), summed over its lines. */
export interface JurisdictionTaxGroup {
  key: string;
  name: string;
  level: TaxJurisdictionLevel | null;
  stateCode: string | null;
  /** Percentage of the taxable part, e.g. 6.25. */
  rate: number;
  taxableAmount: number;
  taxAmount: number;
  exemptAmount: number;
  nonTaxableAmount: number;
  /** Why part of the sale was exempt, without repeats. */
  exemptReasons: string[];
  certificateIds: string[];
  kind: 'tax' | 'use';
  /** US sales tax / use tax row (has a jurisdiction), as opposed to a VAT / GST rate row. */
  isJurisdiction: boolean;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The rows of a stored breakdown grouped per jurisdiction (and rate: a state
 * can tax two product classes differently), state first, then county, city
 * and district; use tax after the sales tax. VAT / GST rows stay one group per
 * rate name, in the order the server sent them.
 */
export function groupTaxBreakdown(rows: readonly TaxBreakdownRow[] | null | undefined): JurisdictionTaxGroup[] {
  const groups = new Map<string, JurisdictionTaxGroup>();

  for (const row of rows ?? []) {
    const isJurisdiction = Boolean(row.jurisdictionCode || row.jurisdictionName || row.jurisdictionLevel);
    const kind = row.kind === 'use' ? 'use' : 'tax';
    const name = row.jurisdictionName || row.taxRateName || row.jurisdictionCode || '';
    const key = [kind, row.jurisdictionCode ?? name, row.jurisdictionLevel ?? '', row.taxRate, row.component ?? ''].join('|');

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name,
        level: row.jurisdictionLevel ?? null,
        stateCode: row.stateCode ?? null,
        rate: row.taxRate,
        taxableAmount: 0,
        taxAmount: 0,
        exemptAmount: 0,
        nonTaxableAmount: 0,
        exemptReasons: [],
        certificateIds: [],
        kind,
        isJurisdiction,
      };
      groups.set(key, group);
    }
    group.taxableAmount = roundCents(group.taxableAmount + toNumber(row.taxableAmount));
    group.taxAmount = roundCents(group.taxAmount + toNumber(row.taxAmount));
    group.exemptAmount = roundCents(group.exemptAmount + toNumber(row.exemptAmount));
    group.nonTaxableAmount = roundCents(group.nonTaxableAmount + toNumber(row.nonTaxableAmount));
    if (row.exemptReason && !group.exemptReasons.includes(row.exemptReason)) group.exemptReasons.push(row.exemptReason);
    if (row.certificateId && !group.certificateIds.includes(row.certificateId)) group.certificateIds.push(row.certificateId);
  }

  const all = [...groups.values()];
  if (!all.some((group) => group.isJurisdiction || group.kind === 'use')) return all;
  return all.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'tax' ? -1 : 1;
    const level = (a.level ? LEVEL_ORDER[a.level] : 9) - (b.level ? LEVEL_ORDER[b.level] : 9);
    return level !== 0 ? level : a.name.localeCompare(b.name);
  });
}

/** True when part of the sale was exempt (a customer's certificate) or not taxable. */
export function hasExemptRows(rows: readonly TaxBreakdownRow[] | null | undefined): boolean {
  return (rows ?? []).some((row) => toNumber(row.exemptAmount) > 0 || Boolean(row.exemptReason));
}

/** The reasons parts of the sale were exempt, without repeats. */
export function exemptReasonsOf(rows: readonly TaxBreakdownRow[] | null | undefined): string[] {
  const reasons: string[] = [];
  for (const row of rows ?? []) {
    if (row.exemptReason && !reasons.includes(row.exemptReason)) reasons.push(row.exemptReason);
  }
  return reasons;
}

/** The certificates the exempt rows rest on, without repeats. */
export function exemptCertificateIdsOf(rows: readonly TaxBreakdownRow[] | null | undefined): string[] {
  const ids: string[] = [];
  for (const row of rows ?? []) {
    if (row.certificateId && !ids.includes(row.certificateId)) ids.push(row.certificateId);
  }
  return ids;
}

/** "resale" / "non_profit" becomes "Resale" / "Non profit": the server's reasons are codes or free text. */
export function readableReason(reason: string): string {
  const spaced = reason.replaceAll('_', ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Sales tax charged to the customer (use tax is the buyer's own accrual). */
export function chargedTaxTotal(rows: readonly TaxBreakdownRow[] | null | undefined): number {
  return roundCents((rows ?? []).filter((row) => row.kind !== 'use').reduce((sum, row) => sum + toNumber(row.taxAmount), 0));
}

/** Use tax accrued on a bill: owed to the state, not part of what the vendor is paid. */
export function useTaxTotal(rows: readonly TaxBreakdownRow[] | null | undefined): number {
  return roundCents((rows ?? []).filter((row) => row.kind === 'use').reduce((sum, row) => sum + toNumber(row.taxAmount), 0));
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** `not_registered_in_state` or `tax_engine_unavailable: the provider timed out` into code and detail. */
export function parseTaxWarning(warning: string): { code: string; detail: string | null } {
  const index = warning.indexOf(':');
  if (index === -1) return { code: warning.trim(), detail: null };
  return { code: warning.slice(0, index).trim(), detail: warning.slice(index + 1).trim() || null };
}

/** Warnings that say the tax of a draft was not calculated (the engine could not answer). */
export function hasEngineUnavailableWarning(warnings: readonly string[] | null | undefined): boolean {
  return (warnings ?? []).some((w) => parseTaxWarning(w).code === 'tax_engine_unavailable');
}

/** Warnings that say recording the document with the provider engine failed (retry with commit-tax). */
export function hasProviderSyncWarning(warnings: readonly string[] | null | undefined): boolean {
  return (warnings ?? []).some((w) => {
    const { code } = parseTaxWarning(w);
    return code === 'commit_failed' || code === 'reverse_failed';
  });
}

/**
 * The warning in words. `texts` maps codes to messages (`{state}` is replaced
 * with the state, or with `stateFallback` when the document has none); an
 * unknown code comes back as readable text instead of being dropped.
 */
export function taxWarningText(
  warning: string,
  texts: Readonly<Record<string, string>>,
  context: { state?: string | null; stateFallback?: string } = {},
): string {
  const { code, detail } = parseTaxWarning(warning);
  const known = texts[code];
  if (known) return known.replaceAll('{state}', context.state || context.stateFallback || '');
  const readable = code.replaceAll('_', ' ');
  return detail ? `${readable}: ${detail}` : readable;
}

/** Warnings without repeats, `not_registered_in_state` etc. kept in the order the server sent them. */
export function uniqueWarnings(warnings: readonly string[] | null | undefined): string[] {
  return [...new Set((warnings ?? []).filter((w) => w.trim() !== ''))];
}

// ---------------------------------------------------------------------------
// Exempt notice
// ---------------------------------------------------------------------------

/** The four wordings of the exempt-sale notice (screen and PDF). `{reason}` and `{number}` are replaced. */
export interface ExemptNoticeLabels {
  reason: string;
  reasonWithCertificate: string;
  certificateOnly: string;
  notice: string;
}

/**
 * "Exempt sale: resale. Certificate no. A-123." for a document with exempt
 * rows; the reasons and certificate numbers are listed without repeats.
 */
export function exemptNoticeText(
  labels: ExemptNoticeLabels,
  reasons: readonly string[],
  certificateNumbers: readonly string[],
): string {
  const reason = [...new Set(reasons.map(readableReason))].join(', ');
  const number = [...new Set(certificateNumbers.filter((n) => n.trim() !== ''))].join(', ');
  if (reason && number) return labels.reasonWithCertificate.replace('{reason}', reason).replace('{number}', number);
  if (reason) return labels.reason.replace('{reason}', reason);
  if (number) return labels.certificateOnly.replace('{number}', number);
  return labels.notice;
}
