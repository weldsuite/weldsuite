/**
 * The sales tax engine contract (docs/plans/weldbooks-us.md §3).
 *
 * One interface for every engine: the manual engine (rates the user keeps)
 * and provider engines (Stripe Tax, Avalara AvaTax) that call a rate API.
 * books-api calls it for invoices, credit memos and bills; commerce-api uses
 * the same engine at checkout. Amounts are in the document currency, rates
 * are percentages (6.25 = 6.25%).
 */

import type { PostalAddress } from '@weldsuite/db/schema';

export type SalesTaxEngineId = 'manual' | 'stripe_tax' | 'avalara';

/** WeldBooks product tax codes; mapped to each provider's codes in `jurisdictions/us/tax-codes.ts`. */
export type WeldTaxCode =
  | 'general'
  | 'saas'
  | 'digital_goods'
  | 'services'
  | 'professional_services'
  | 'shipping'
  | 'handling'
  | 'food_grocery'
  | 'prepared_food'
  | 'clothing'
  | 'prescription_drugs'
  | 'non_taxable';

export type TaxUse = 'business' | 'personal';

export type ExemptReason = 'resale' | 'nonprofit' | 'government' | 'manufacturing' | 'agricultural' | 'other';

export type JurisdictionLevel = 'state' | 'county' | 'city' | 'district';

export interface ExemptionCertificateRef {
  id: string;
  /** USPS codes the certificate covers. */
  states: string[];
  reason: ExemptReason;
  certificateNumber?: string | null;
  form?: string | null;
  issuedOn?: string | null;
  /** Explicit expiry; when empty the per-state rule decides. */
  expiresOn?: string | null;
  blanket: boolean;
  /** Single-purchase certificate: the invoice it covers. */
  invoiceId?: string | null;
  status: 'valid' | 'expired' | 'pending' | 'revoked';
  /** Tax date of the last sale made on this certificate; the SST blanket rule (12 months between purchases) reads it. */
  lastUsedOn?: string | null;
}

/** An agency the entity is registered with (or monitors). Tax is charged only while `registered`. */
export interface SalesTaxRegistration {
  agencyId: string;
  stateCode: string;
  level: 'state' | 'local';
  localJurisdictionCode?: string | null;
  status: 'registered' | 'pending' | 'monitoring' | 'closed';
  registeredFrom?: string | null;
  registeredUntil?: string | null;
}

export interface SalesTaxRequestLine {
  lineId: string;
  /** Line amount net of seller discounts (quantity × price − discount). Tax-inclusive when `taxIncluded`. */
  amount: number;
  quantity: number;
  taxCode: WeldTaxCode | string;
  use: TaxUse;
  taxIncluded?: boolean;
  /** Tax the user set by hand. The engine keeps it (spread over the jurisdictions pro rata) and records the reason. */
  override?: { amount: number; reason: string } | null;
}

export interface SalesTaxRequest {
  entityId: string;
  /** `use` = use tax on a purchase (bill), computed at the delivery address. */
  documentType: 'invoice' | 'credit_memo' | 'bill' | 'estimate' | 'order';
  documentId?: string;
  documentNumber?: string;
  /** Tax point, YYYY-MM-DD. Rates and rules are picked by this date, never by today. */
  documentDate: string;
  currency: string;
  /** Entity location or warehouse. */
  shipFrom: PostalAddress;
  /** Falls back to bill-to; null when neither has a state. */
  shipTo: PostalAddress | null;
  customer: {
    partyId: string;
    certificates: ExemptionCertificateRef[];
    /** Customer default; a line's `use` overrides it. */
    use?: TaxUse;
  };
  registrations: SalesTaxRegistration[];
  lines: SalesTaxRequestLine[];
  /** A marketplace facilitator collects the tax: no tax charged, the sale still counts for nexus. */
  marketplaceFacilitated?: boolean;
  /** sales (default) or use: use tax accrued by the buyer on a purchase. */
  direction?: 'sales' | 'use';
}

export interface SalesTaxDetail {
  /** FIPS / SST code where available, else the engine's own code. */
  jurisdictionCode: string;
  jurisdictionName: string;
  level: JurisdictionLevel;
  stateCode: string;
  agencyId?: string;
  /** The location code the state's return asks for. */
  reportingCode?: string;
  /** Percent, e.g. 6.25. */
  rate: number;
  taxableAmount: number;
  exemptAmount: number;
  nonTaxableAmount: number;
  /** Rounded to the cent. */
  tax: number;
  /** Before rounding (at least three decimals), so returns reconcile. */
  unroundedTax: number;
  exemptReason?: ExemptReason | string;
  certificateId?: string;
}

export interface SalesTaxLineResult {
  lineId: string;
  /** The line amount before exemptions (net of tax when the line was tax-inclusive). */
  grossAmount: number;
  taxableAmount: number;
  exemptAmount: number;
  nonTaxableAmount: number;
  tax: number;
  /** The user's override was applied. */
  overridden?: boolean;
  overrideReason?: string;
  details: SalesTaxDetail[];
}

export type SalesTaxWarning =
  | 'not_registered_in_state'
  | 'address_unverified'
  | 'no_ship_to'
  | 'certificate_expired'
  | 'certificate_missing'
  | 'marketplace_facilitated'
  | 'zone_not_found'
  /** Use tax accrued in a state where the entity has no active registration (no agency on the details). */
  | 'no_use_tax_registration'
  /** The registered agency has no rate in force for the address (nothing was calculated). */
  | 'rates_not_configured'
  /** A hand-set tax had no jurisdiction to ride on. */
  | 'override_not_applied'
  /** Provider engines: the rates are today's, the provider can't date a calculation this far back. */
  | 'provider_rate_date_ignored'
  | 'provider_not_supported'
  /** The provider has no nexus where WeldBooks has a registration. */
  | 'provider_nexus_missing'
  | (string & {});

export interface SalesTaxResult {
  engine: SalesTaxEngineId | (string & {});
  /** Provider calculation / transaction id. */
  engineRef?: string;
  calculatedAt: string;
  /** How the sale was sourced. `none` when nothing was taxed for lack of registration or address. */
  sourcing: 'origin' | 'modified_origin' | 'destination' | 'none';
  shipToState?: string;
  shipToPostalCode?: string;
  lines: SalesTaxLineResult[];
  totalTax: number;
  warnings: SalesTaxWarning[];
}

export interface AddressValidation {
  valid: boolean;
  normalized?: PostalAddress;
  messages?: string[];
}

export interface ReverseLine {
  lineId: string;
  /** Positive amounts to reverse. */
  amount: number;
  tax: number;
}

export interface ProviderRegistration {
  stateCode: string;
  ref: string;
  active: boolean;
}

export interface SalesTaxEngine {
  readonly id: SalesTaxEngineId | (string & {});
  calculate(req: SalesTaxRequest): Promise<SalesTaxResult>;
  /** Record a finalized document with the provider (provider engines only). */
  commit?(req: SalesTaxRequest, result: SalesTaxResult): Promise<{ ref: string }>;
  /** Credit memo against a committed document. */
  reverse?(ref: string, lines: ReverseLine[], opts: { documentNumber: string; date: string }): Promise<{ ref: string }>;
  /** Void a committed document entirely. */
  void?(ref: string): Promise<void>;
  validateAddress?(address: PostalAddress): Promise<AddressValidation>;
  /** The provider's own registrations, to check them against WeldBooks agencies. */
  listRegistrations?(): Promise<ProviderRegistration[]>;
}

/**
 * An engine failure. `unreachable` is retryable; callers keep the draft's last
 * calculation and refuse to finalize. An engine failure never posts zero tax.
 */
export class SalesTaxEngineError extends Error {
  constructor(
    message: string,
    readonly code: 'unreachable' | 'auth' | 'invalid_request' | 'not_configured' | 'rate_limited',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SalesTaxEngineError';
  }
}

// ---------------------------------------------------------------------------
// Manual engine data (sales_tax_* tables, loaded per entity)
// ---------------------------------------------------------------------------

export interface ManualJurisdiction {
  id: string;
  agencyId: string;
  stateCode: string;
  level: JurisdictionLevel;
  code?: string | null;
  name: string;
  reportingCode?: string | null;
  rates: Array<{ rate: number; effectiveFrom: string; effectiveTo?: string | null }>;
}

export interface ManualZone {
  id: string;
  agencyId: string;
  stateCode: string;
  name: string;
  jurisdictionIds: string[];
  /** Five-digit ZIPs and inclusive ranges. */
  postalCodes: Array<string | { from: string; to: string }>;
  isOrigin: boolean;
  /** Lower wins. */
  priority: number;
}

export interface ManualTaxabilityRule {
  agencyId: string;
  taxCode: string;
  taxable: boolean;
  /** 0–100. */
  taxablePercent: number;
  appliesToUse: 'any' | TaxUse;
  rateOverride?: number | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface ManualEngineData {
  jurisdictions: ManualJurisdiction[];
  zones: ManualZone[];
  rules: ManualTaxabilityRule[];
}

export interface SalesTaxEngineConfig {
  engine: SalesTaxEngineId;
  manual?: ManualEngineData;
  /** Restricted key of the customer's own Stripe account. */
  stripeTax?: { apiKey: string };
  avalara?: {
    accountId: string;
    licenseKey: string;
    companyCode: string;
    environment: 'sandbox' | 'production';
  };
  /** Injected for tests (recorded HTTP fixtures). */
  fetch?: typeof fetch;
}
