/**
 * Reseller licensing — shared Zod v3 contract and the pure billing maths.
 *
 * A partner (reseller) licenses its customers' workspaces (apps, monthly
 * credits, seats), records what it charges each customer (never below the
 * contract's minimum selling price), and pays WeldSuite its share of that
 * monthly. Plan: docs/plans/reseller-licensing.md. Tables: master DB,
 * `packages/core/db/src/schema/partners.ts`.
 *
 * Readers: app-api (partner portal `/api/partner/*`, onboarding territory
 * check), billing-worker (statements, sweeps, admin routes), the admin console
 * and the platform SPA. The money helpers are here, not in a worker, so the
 * portal's live preview and the statement run can never disagree.
 *
 * All money is handled as integer cents (amounts) or micro-units (per-credit
 * prices, 6 decimals); strings at the edges, matching Postgres `numeric`.
 */

import { z } from 'zod';

// ============================================================================
// Enums (mirror packages/core/db/src/schema/partners.ts)
// ============================================================================

export const PARTNER_STATUSES = ['active', 'past_due', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const PARTNER_MEMBER_ROLES = ['owner', 'admin', 'billing', 'viewer'] as const;
export type PartnerMemberRole = (typeof PARTNER_MEMBER_ROLES)[number];

export const WORKSPACE_LICENCE_STATUSES = ['active', 'suspended', 'ended'] as const;
export type WorkspaceLicenceStatus = (typeof WORKSPACE_LICENCE_STATUSES)[number];

export const PARTNER_STATEMENT_STATUSES = ['draft', 'final', 'invoiced', 'paid', 'void'] as const;
export type PartnerStatementStatus = (typeof PARTNER_STATEMENT_STATUSES)[number];

export const PARTNER_REQUEST_STATUSES = ['new', 'contacted', 'provisioned', 'declined'] as const;
export type PartnerRequestStatus = (typeof PARTNER_REQUEST_STATUSES)[number];

/**
 * Contract currencies. A partner is billed in one, and its resale prices,
 * minimums and statements are all in it. Two-decimal currencies only: the
 * maths works in cents, and Stripe's zero-decimal currencies (JPY, CLP, …)
 * would be off by a factor of 100.
 */
export const PARTNER_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN'] as const;
export type PartnerCurrency = (typeof PARTNER_CURRENCIES)[number];

// ============================================================================
// Partner permissions (portal). Not `weld*` workspace permissions: a partner
// is not a workspace, and its users may belong to no workspace at all.
// ============================================================================

export const PARTNER_PERMISSIONS = {
  'partner:workspaces:read': ['owner', 'admin', 'billing', 'viewer'],
  'partner:workspaces:manage': ['owner', 'admin'],
  'partner:licences:manage': ['owner', 'admin'],
  'partner:billing:read': ['owner', 'admin', 'billing'],
  'partner:team:manage': ['owner'],
} as const satisfies Record<string, readonly PartnerMemberRole[]>;

export type PartnerPermission = keyof typeof PARTNER_PERMISSIONS;

export function partnerRoleCan(role: PartnerMemberRole, permission: PartnerPermission): boolean {
  return (PARTNER_PERMISSIONS[permission] as readonly PartnerMemberRole[]).includes(role);
}

// ============================================================================
// Field schemas
// ============================================================================

/** Highest monthly amount accepted anywhere, a guard against a typo'd extra zero or two. */
export const MAX_PARTNER_AMOUNT = 1_000_000;

/** A money amount with at most 2 decimals, as a string ("199.00"). */
export const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,7}(\.\d{1,2})?$/, 'Amount with at most 2 decimals')
  .refine((v) => Number(v) <= MAX_PARTNER_AMOUNT, 'Amount too large');

/** A per-credit price with at most 6 decimals ("0.004"). */
export const unitPriceSchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}(\.\d{1,6})?$/, 'Price with at most 6 decimals');

export const countryCodeSchema = z
  .string()
  .trim()
  .length(2)
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z]{2}$/.test(v), 'ISO 3166-1 alpha-2 country code');

/** A `PERMISSION_APPS` app code (`weldcrm`, `welddesk`, …). */
export const appCodeSchema = z.string().trim().regex(/^[a-z][a-z0-9-]{1,49}$/, 'App code');

export const resalePricingSchema = z.discriminatedUnion('model', [
  z.object({ model: z.literal('flat'), amount: moneySchema }),
  z.object({
    model: z.literal('per_seat'),
    amount: moneySchema,
    minSeats: z.number().int().min(1).max(100_000).optional(),
  }),
]);
export type ResalePricing = z.infer<typeof resalePricingSchema>;

/** The editable part of a licence (a package, or one workspace's licence). */
export const licenceTermsSchema = z.object({
  allowedApps: z.array(appCodeSchema).max(100).transform((apps) => [...new Set(apps)]),
  monthlyCredits: z.number().int().min(0).max(100_000_000),
  creditRolloverCap: z.number().int().min(0).max(100_000_000).default(0),
  maxSeats: z.number().int().min(1).max(100_000).nullable().default(null),
  featurePlanId: z.string().trim().min(1).max(30).nullable().default(null),
  storageGb: z.number().int().min(1).max(100_000).nullable().default(null),
  resalePricing: resalePricingSchema,
});
export type LicenceTerms = z.infer<typeof licenceTermsSchema>;

/** Full licence snapshot, as stored in `workspace_licence_changes.snapshot`. */
export interface LicenceSnapshot extends LicenceTerms {
  status: WorkspaceLicenceStatus;
  packageId: string | null;
}

// ============================================================================
// Request bodies
// ============================================================================

// --- Admin console (billing-worker /api/internal/admin/partners/*) ---------

export const partnerProfileSchema = z.object({
  name: z.string().trim().min(1).max(255),
  legalName: z.string().trim().max(255).nullable().optional(),
  country: countryCodeSchema.nullable().optional(),
  taxId: z.string().trim().max(100).nullable().optional(),
  billingEmail: z.string().trim().email().max(255),
  supportEmail: z.string().trim().email().max(255).nullable().optional(),
  supportUrl: z.string().trim().url().max(500).nullable().optional(),
  websiteUrl: z.string().trim().url().max(500).nullable().optional(),
  logoUrl: z.string().trim().url().max(500).nullable().optional(),
});
export type PartnerProfileInput = z.infer<typeof partnerProfileSchema>;

export const partnerContractSchema = z.object({
  effectiveFrom: z.string().datetime().optional(),
  currency: z.enum(PARTNER_CURRENCIES).default('USD'),
  revenueShareBps: z.number().int().min(0).max(10_000).default(7500),
  baseMinimum: moneySchema,
  includedSeats: z.number().int().min(0).max(100_000).default(0),
  seatFloorPrice: moneySchema.default('0'),
  includedCredits: z.number().int().min(0).max(100_000_000).default(0),
  creditFloorPrice: unitPriceSchema.default('0'),
  extraCreditPrice: unitPriceSchema.default('0'),
  allowedFeaturePlanIds: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  paymentTermsDays: z.number().int().min(0).max(120).default(30),
  pastDueAfterDays: z.number().int().min(1).max(120).default(14),
  readOnlyAfterDays: z.number().int().min(1).max(365).default(30),
  notes: z.string().max(5000).nullable().optional(),
}).refine((c) => c.readOnlyAfterDays > c.pastDueAfterDays, {
  message: 'readOnlyAfterDays must be after pastDueAfterDays',
  path: ['readOnlyAfterDays'],
});
export type PartnerContractInput = z.infer<typeof partnerContractSchema>;

export const createPartnerSchema = partnerProfileSchema.extend({
  /** Email of the partner's first owner; invited to the portal. */
  ownerEmail: z.string().trim().email().max(255),
  contract: partnerContractSchema,
  territories: z.array(countryCodeSchema).max(250).default([]),
});
export type CreatePartnerInput = z.infer<typeof createPartnerSchema>;

export const partnerTerritoriesSchema = z.object({
  countries: z.array(countryCodeSchema).max(250),
});

export const partnerStatusOverrideSchema = z.object({
  status: z.enum(PARTNER_STATUSES).optional(),
  /** ISO timestamp; null clears the pause. */
  dunningPausedUntil: z.string().datetime().nullable().optional(),
  reason: z.string().trim().min(1).max(1000),
});

/** Move an existing direct workspace under a partner (admin only). */
export const attachWorkspaceSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  licence: licenceTermsSchema.extend({ packageId: z.string().max(30).nullable().default(null) }),
  /** Cancel the direct Stripe subscription now (with proration) or at period end. */
  cancelDirectSubscription: z.enum(['now', 'period_end']).default('period_end'),
  reason: z.string().trim().min(1).max(1000),
});

export const detachWorkspaceSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

// --- Partner portal (app-api /api/partner/*) -------------------------------

export const licencePackageSchema = licenceTermsSchema.omit({ resalePricing: true }).extend({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  defaultResalePricing: resalePricingSchema,
});
export type LicencePackageInput = z.infer<typeof licencePackageSchema>;

export const workspaceLicenceInputSchema = licenceTermsSchema.extend({
  /** Omitted keeps the workspace's current package; `null` clears the link. */
  packageId: z.string().max(30).nullable().optional(),
  reason: z.string().trim().max(1000).optional(),
});
export type WorkspaceLicenceInput = z.infer<typeof workspaceLicenceInputSchema>;

export const createManagedWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(255),
  country: countryCodeSchema,
  /** Neon region; omitted = the onboarding default for the country. */
  region: z.string().trim().max(50).optional(),
  /** The customer's owner, invited to the new workspace. */
  ownerEmail: z.string().trim().email().max(255),
  licence: workspaceLicenceInputSchema,
  /** Set when provisioning from a territory request. */
  requestId: z.string().max(30).optional(),
});
export type CreateManagedWorkspaceInput = z.infer<typeof createManagedWorkspaceSchema>;

export const licenceStatusChangeSchema = z.object({
  status: z.enum(WORKSPACE_LICENCE_STATUSES),
  reason: z.string().trim().max(1000).optional(),
});

export const partnerCreditGrantSchema = z.object({
  credits: z.number().int().min(1).max(10_000_000),
  note: z.string().trim().max(500).optional(),
});

export const partnerMemberInviteSchema = z.object({
  email: z.string().trim().email().max(255),
  role: z.enum(PARTNER_MEMBER_ROLES),
});

export const partnerMemberUpdateSchema = z.object({
  role: z.enum(PARTNER_MEMBER_ROLES),
});

export const partnerSettingsSchema = partnerProfileSchema.pick({
  supportEmail: true,
  supportUrl: true,
  websiteUrl: true,
  logoUrl: true,
});

export const partnerRequestUpdateSchema = z.object({
  status: z.enum(['contacted', 'declined']),
});

// --- Onboarding (territory) ------------------------------------------------

export const partnerWorkspaceRequestSchema = z.object({
  companyName: z.string().trim().min(1).max(255),
  country: countryCodeSchema,
  selectedApps: z.array(appCodeSchema).max(50).default([]),
  message: z.string().trim().max(2000).optional(),
});
export type PartnerWorkspaceRequestInput = z.infer<typeof partnerWorkspaceRequestSchema>;

// ============================================================================
// Response shapes (`{ data }` envelopes carry these)
// ============================================================================

/** What end customers and signups see about a partner. */
export interface PartnerPublicInfo {
  id: string;
  name: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportUrl: string | null;
}

/** `GET /api/partner/me` — the caller's partner memberships. */
export interface PartnerMembership {
  partnerId: string;
  partnerName: string;
  role: PartnerMemberRole;
  status: PartnerStatus;
}

export interface PartnerContractView {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  currency: string;
  revenueShareBps: number;
  baseMinimum: string;
  includedSeats: number;
  seatFloorPrice: string;
  includedCredits: number;
  creditFloorPrice: string;
  extraCreditPrice: string;
  allowedFeaturePlanIds: string[];
  paymentTermsDays: number;
  pastDueAfterDays: number;
  readOnlyAfterDays: number;
}

export interface ManagedWorkspaceRow {
  workspaceId: string;
  name: string;
  slug: string;
  provisioningStatus: string | null;
  ownerEmail: string | null;
  licence: LicenceSnapshot & { startsAt: string; endsAt: string | null };
  packageName: string | null;
  activeMembers: number;
  creditsUsedThisPeriod: number;
  creditBalance: number;
  /** This month so far, at the current licence. */
  estimate: WorkspaceMonthPrice;
  createdAt: string;
}

export interface LicenceChangeView {
  id: string;
  snapshot: LicenceSnapshot;
  changedBy: string | null;
  changedByType: 'partner' | 'admin' | 'system';
  reason: string | null;
  changedAt: string;
}

export interface PartnerStatementLineView {
  workspaceId: string;
  workspaceName: string;
  daysActive: number;
  daysInPeriod: number;
  seatsBilled: number;
  resale: string;
  shareAmount: string;
  floorAmount: string;
  creditFloorAmount: string;
  extraCreditsAmount: string;
  due: string;
  margin: string;
}

export interface PartnerStatementView {
  id: string | null; // null for the live (unsaved) current-month preview
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: PartnerStatementStatus | 'preview';
  totalResale: string;
  totalDue: string;
  totalMargin: string;
  stripeInvoiceUrl: string | null;
  stripeInvoicePdf: string | null;
  dueAt: string | null;
  paidAt: string | null;
  lines: PartnerStatementLineView[];
}

/** The billing page of a managed workspace (`GET /api/billing/managed`). */
export interface ManagedBillingInfo {
  partner: PartnerPublicInfo;
  partnerStatus: PartnerStatus;
  licence: {
    status: WorkspaceLicenceStatus;
    allowedApps: string[];
    monthlyCredits: number;
    maxSeats: number | null;
  };
  creditsUsedThisPeriod: number;
  creditBalance: number;
  activeMembers: number;
  readOnly: boolean;
}

/** `409 PARTNER_TERRITORY` details from workspace creation and checkout. */
export interface PartnerTerritoryErrorDetails {
  country: string;
  partner: PartnerPublicInfo;
}

// ============================================================================
// Money maths
// ============================================================================

/** "199.5" → 19950. Throws on anything that is not a non-negative decimal. */
export function toCents(amount: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Invalid money amount: ${amount}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** 19950 → "199.50". Negative values keep their sign. */
export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "0.004" → 4000 micro-units (1e-6 of the currency unit). */
export function toMicros(price: string): number {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!m) throw new Error(`Invalid unit price: ${price}`);
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'));
}

/** credits × unit price, rounded to cents. */
export function creditsToCents(credits: number, unitPrice: string): number {
  // micros × credits = 1e-6 units; cents = units × 100 → divide by 1e4.
  return Math.round((credits * toMicros(unitPrice)) / 10_000);
}

/** The contract terms the maths needs. */
export interface PricingContract {
  revenueShareBps: number;
  baseMinimum: string;
  includedSeats: number;
  seatFloorPrice: string;
  includedCredits: number;
  creditFloorPrice: string;
}

/** The licence terms the maths needs. */
export interface PricingLicence {
  monthlyCredits: number;
  resalePricing: ResalePricing;
}

/** One workspace for one full month. All amounts in cents. */
export interface WorkspaceMonthPrice {
  /** What the partner charges its customer. */
  resale: number;
  /** resale × revenue share. */
  share: number;
  /** The base minimum alone. */
  baseFloor: number;
  /** The minimum's part for billable seats above the included ones. */
  seatFloor: number;
  /** The minimum's part for licensed credits above the included ones. */
  creditFloor: number;
  /** The minimum selling price: baseFloor + seatFloor + creditFloor. */
  floor: number;
  /** What WeldSuite bills: max(resale, floor) × revenue share. */
  due: number;
  /** resale − due (below the partner's 25% when the minimum was billed instead). */
  margin: number;
  /** `floor` when the price is below the minimum, so the minimum is billed instead. */
  basis: 'share' | 'floor';
}

/** What the partner charges its customer for a month at `seats` billable seats. */
export function resaleCents(pricing: ResalePricing, seats: number): number {
  const unit = toCents(pricing.amount);
  if (pricing.model === 'flat') return unit;
  return unit * Math.max(seats, pricing.minSeats ?? 0);
}

/** The minimum selling price for one month, in cents, and its parts. */
export interface MonthMinimum {
  base: number;
  seats: number;
  credits: number;
  total: number;
}

/**
 * The minimum a partner may charge for a workspace for one month:
 *   base_minimum
 *   + max(0, seats − included_seats) × seat_floor_price
 *   + max(0, licensed_credits − included_credits) × credit_floor_price
 */
export function minimumCents(contract: PricingContract, monthlyCredits: number, seats: number): MonthMinimum {
  const base = toCents(contract.baseMinimum);
  const seatPart = toCents(contract.seatFloorPrice) * Math.max(0, seats - contract.includedSeats);
  const credits = creditsToCents(Math.max(0, monthlyCredits - contract.includedCredits), contract.creditFloorPrice);
  return { base, seats: seatPart, credits, total: base + seatPart + credits };
}

function shareOf(cents: number, revenueShareBps: number): number {
  return Math.round((cents * revenueShareBps) / 10_000);
}

/**
 * Price one workspace for a full month:
 *   due = max(resale, minimum) × revenue_share
 * A licence is refused below the minimum when it is written
 * (`resaleMinimumShortfall`); the max() covers what can still change later,
 * such as a new contract with a higher minimum.
 */
export function priceWorkspaceMonth(
  contract: PricingContract,
  licence: PricingLicence,
  seats: number,
): WorkspaceMonthPrice {
  const resale = resaleCents(licence.resalePricing, seats);
  const minimum = minimumCents(contract, licence.monthlyCredits, seats);
  const due = shareOf(Math.max(resale, minimum.total), contract.revenueShareBps);
  return {
    resale,
    share: shareOf(resale, contract.revenueShareBps),
    baseFloor: minimum.base,
    seatFloor: minimum.seats,
    creditFloor: minimum.credits,
    floor: minimum.total,
    due,
    margin: resale - due,
    basis: resale >= minimum.total ? 'share' : 'floor',
  };
}

/** Why a licence's price is refused (`resaleMinimumShortfall`). Amounts in cents. */
export type ResaleMinimumShortfall =
  /** At `seats` billable seats the price is below the minimum. */
  | { reason: 'below_minimum'; seats: number; minimum: number; price: number }
  /** A flat price with unlimited seats cannot keep up with a per-seat minimum. */
  | { reason: 'needs_seat_limit'; seatFloorPrice: number }
  /** With unlimited seats, the per-seat price must be at least the minimum per extra seat. */
  | { reason: 'seat_price_too_low'; seatFloorPrice: number };

/**
 * Whether a licence's price covers the minimum selling price at every seat
 * count the licence allows (1 up to `maxSeats`, or without limit). Null when it
 * does, else the largest shortfall.
 *
 * Price and minimum are both piecewise linear in the seat count and bend only
 * at `minSeats` (per-seat price) and `includedSeats` (minimum), so checking
 * those points and the ends of the range is exhaustive. Without a seat limit
 * (`maxSeats` null or absent) the price must also grow at least as fast as the
 * minimum.
 */
export function resaleMinimumShortfall(
  contract: PricingContract,
  licence: PricingLicence & { maxSeats?: number | null },
): ResaleMinimumShortfall | null {
  const pricing = licence.resalePricing;
  const maxSeats = licence.maxSeats ?? null;
  const minSeats = pricing.model === 'per_seat' ? (pricing.minSeats ?? 1) : 1;
  const seatFloorPrice = toCents(contract.seatFloorPrice);
  if (maxSeats === null && seatFloorPrice > 0) {
    if (pricing.model === 'flat') return { reason: 'needs_seat_limit', seatFloorPrice };
    if (toCents(pricing.amount) < seatFloorPrice) return { reason: 'seat_price_too_low', seatFloorPrice };
  }
  const top = maxSeats ?? Math.max(1, contract.includedSeats, minSeats);
  let worst: { seats: number; minimum: number; price: number } | null = null;
  for (const point of [1, minSeats, contract.includedSeats, top]) {
    const seats = Math.min(Math.max(point, 1), top);
    const minimum = minimumCents(contract, licence.monthlyCredits, seats).total;
    const price = resaleCents(pricing, seats);
    const gap = minimum - price;
    if (gap <= 0) continue;
    if (!worst || gap > worst.minimum - worst.price || (gap === worst.minimum - worst.price && seats < worst.seats)) {
      worst = { seats, minimum, price };
    }
  }
  return worst ? { reason: 'below_minimum', ...worst } : null;
}

/** `400 BELOW_MINIMUM` details from a licence or package write. Money in the contract currency. */
export interface BelowMinimumDetails {
  reason: ResaleMinimumShortfall['reason'];
  currency: string;
  includedSeats: number;
  /** `below_minimum`: the seat count where the price falls short most. */
  seats: number | null;
  /** `below_minimum`: the minimum and the price at `seats`. */
  minimum: string | null;
  price: string | null;
  /** `needs_seat_limit` / `seat_price_too_low`: the minimum per extra seat. */
  seatFloorPrice: string | null;
  /** English, for logs and the admin console. */
  message: string;
}

export function belowMinimumDetails(
  shortfall: ResaleMinimumShortfall,
  contract: Pick<PricingContract, 'includedSeats'> & { currency: string },
): BelowMinimumDetails {
  const { currency, includedSeats } = contract;
  const base = { reason: shortfall.reason, currency, includedSeats, seats: null, minimum: null, price: null, seatFloorPrice: null };
  if (shortfall.reason === 'below_minimum') {
    const minimum = fromCents(shortfall.minimum);
    const price = fromCents(shortfall.price);
    const seats = `${shortfall.seats} ${shortfall.seats === 1 ? 'seat' : 'seats'}`;
    return {
      ...base,
      seats: shortfall.seats,
      minimum,
      price,
      message: `At ${seats} the price is ${price} ${currency}, below the minimum of ${minimum} ${currency}`,
    };
  }
  const seatFloorPrice = fromCents(shortfall.seatFloorPrice);
  return {
    ...base,
    seatFloorPrice,
    message:
      shortfall.reason === 'needs_seat_limit'
        ? `A flat price needs a seat limit: the minimum rises by ${seatFloorPrice} ${currency} for every seat above ${includedSeats}`
        : `Without a seat limit the price per seat must be at least ${seatFloorPrice} ${currency}`,
  };
}

// ----------------------------------------------------------------------------
// Statement periods
// ----------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The UTC calendar month containing `date`: [start, end). */
export function monthPeriod(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

/** The month before the one containing `date`. */
export function previousMonthPeriod(date: Date): { start: Date; end: Date } {
  return monthPeriod(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

/** `YYYY-MM-DD` of a UTC date. */
export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A licence snapshot recorded at a moment (a `workspace_licence_changes` row). */
export interface LicenceChangePoint {
  changedAt: Date;
  snapshot: Pick<LicenceSnapshot, 'status' | 'monthlyCredits' | 'resalePricing'> & Partial<LicenceSnapshot>;
}

/** Consecutive days in a period billed under the same licence snapshot. */
export interface LicenceSegment {
  snapshot: LicenceChangePoint['snapshot'];
  days: number;
  firstDay: string;
  lastDay: string;
}

/**
 * Split a period into billable day-segments. A UTC day is billed when the
 * licence was `active` or `suspended` at any moment of it, under the last such
 * snapshot of the day: a workspace created on the 10th pays from the 10th, and
 * a licence ended on the 20th pays for the 20th and stops from the 21st.
 * `active` and `suspended` days are billed (the workspace and its data are
 * kept); days spent wholly `ended`, and days before the first change, are not.
 *
 * Credits are billed at the HIGHEST `monthlyCredits` in force at any moment of
 * the day (the licence carried in from the day before, and every change made
 * during it, `ended` snapshots excluded). Credits raised and used within a day
 * and lowered, or the licence ended, before midnight are therefore still
 * billed for that day. Resale price and seats use the last live snapshot.
 */
export function licenceSegments(
  changes: readonly LicenceChangePoint[],
  periodStart: Date,
  periodEnd: Date,
): LicenceSegment[] {
  const sorted = [...changes].sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  const segments: LicenceSegment[] = [];
  const tail: SegmentTail = { base: null, credits: 0 };
  const cursor = { idx: -1 };
  for (let day = periodStart.getTime(); day < periodEnd.getTime(); day += DAY_MS) {
    const live = liveLicenceForDay(sorted, cursor, day);
    if (!live.inForce) continue;
    appendBilledDay(segments, tail, day, live.inForce, live.credits);
  }
  return segments;
}

/** The end-of-day snapshot and credits the last segment was built from. */
interface SegmentTail {
  base: LicenceChangePoint['snapshot'] | null;
  credits: number;
}

/**
 * The licence billed for the UTC day starting at `day`: the last live (not
 * `ended`) snapshot of the day and the day's credit high-water mark. Moves the
 * shared `cursor` over every change up to the end of the day.
 */
function liveLicenceForDay(
  sorted: readonly LicenceChangePoint[],
  cursor: { idx: number },
  day: number,
): { inForce: LicenceChangePoint['snapshot'] | null; credits: number } {
  const endOfDay = day + DAY_MS;
  // Changes stamped exactly at midnight replace the licence before the day starts.
  while (cursor.idx + 1 < sorted.length && sorted[cursor.idx + 1]!.changedAt.getTime() <= day) cursor.idx += 1;
  // The licence carried in from before the day (if any), then the day's changes.
  const carriedIn = cursor.idx >= 0 ? sorted[cursor.idx]!.snapshot : null;
  let inForce = carriedIn && carriedIn.status !== 'ended' ? carriedIn : null;
  let credits = inForce ? inForce.monthlyCredits : 0;
  while (cursor.idx + 1 < sorted.length && sorted[cursor.idx + 1]!.changedAt.getTime() < endOfDay) {
    cursor.idx += 1;
    const snap = sorted[cursor.idx]!.snapshot;
    if (snap.status !== 'ended') {
      inForce = snap;
      credits = Math.max(credits, snap.monthlyCredits);
    }
  }
  return { inForce, credits };
}

/** Add one billed day to the last segment when it continues it, else start a new segment. */
function appendBilledDay(
  segments: LicenceSegment[],
  tail: SegmentTail,
  day: number,
  inForce: LicenceChangePoint['snapshot'],
  dayCredits: number,
): void {
  const key = utcDateKey(new Date(day));
  const last = segments[segments.length - 1];
  const yesterday = utcDateKey(new Date(day - DAY_MS));
  if (last && tail.base === inForce && tail.credits === dayCredits && last.lastDay === yesterday) {
    last.days += 1;
    last.lastDay = key;
    return;
  }
  const snapshot = dayCredits === inForce.monthlyCredits ? inForce : { ...inForce, monthlyCredits: dayCredits };
  segments.push({ snapshot, days: 1, firstDay: key, lastDay: key });
  tail.base = inForce;
  tail.credits = dayCredits;
}

export function daysInPeriod(periodStart: Date, periodEnd: Date): number {
  return Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS);
}

/** One workspace's statement line, in cents. */
export interface StatementLineAmounts {
  daysActive: number;
  daysInPeriod: number;
  seatsBilled: number;
  resale: number;
  share: number;
  /** The minimum selling price's base and seat part. */
  floor: number;
  /** The minimum selling price's credit part. */
  creditFloor: number;
  extraCredits: number;
  due: number;
  margin: number;
  breakdown: Array<{
    firstDay: string;
    lastDay: string;
    days: number;
    resale: number;
    share: number;
    floor: number;
    creditFloor: number;
    due: number;
    basis: 'share' | 'floor';
  }>;
}

/**
 * Price one workspace for a period: each licence segment is priced as a full
 * month (`priceWorkspaceMonth`, with `max(resale, minimum)` applied per
 * segment) and prorated by its share of the period's days. Seats are the
 * period's peak. Extra credits granted in the period are added on top,
 * unprorated.
 */
export function priceWorkspacePeriod(input: {
  contract: PricingContract;
  segments: readonly LicenceSegment[];
  daysInPeriod: number;
  peakSeats: number;
  extraCreditsCents?: number;
}): StatementLineAmounts {
  const { contract, segments, peakSeats } = input;
  const total = input.daysInPeriod;
  const line: StatementLineAmounts = {
    daysActive: 0,
    daysInPeriod: total,
    seatsBilled: 0,
    resale: 0,
    share: 0,
    floor: 0,
    creditFloor: 0,
    extraCredits: input.extraCreditsCents ?? 0,
    due: 0,
    margin: 0,
    breakdown: [],
  };
  const prorate = (cents: number, days: number) => Math.round((cents * days) / total);
  for (const seg of segments) {
    const month = priceWorkspaceMonth(contract, seg.snapshot, peakSeats);
    const part = {
      firstDay: seg.firstDay,
      lastDay: seg.lastDay,
      days: seg.days,
      resale: prorate(month.resale, seg.days),
      share: prorate(month.share, seg.days),
      floor: prorate(month.baseFloor + month.seatFloor, seg.days),
      creditFloor: prorate(month.creditFloor, seg.days),
      due: prorate(month.due, seg.days),
      basis: month.basis,
    };
    line.breakdown.push(part);
    line.daysActive += seg.days;
    line.resale += part.resale;
    line.share += part.share;
    line.floor += part.floor;
    line.creditFloor += part.creditFloor;
    line.due += part.due;
    // Per-seat prices bill at least `minSeats`; the minimum (and a flat price)
    // follows the real peak.
    const pricing = seg.snapshot.resalePricing;
    const billed = pricing.model === 'per_seat' ? Math.max(peakSeats, pricing.minSeats ?? 0) : peakSeats;
    line.seatsBilled = Math.max(line.seatsBilled, billed);
  }
  // The partner resells extra credits however it likes and records no price
  // for them, so its margin is on the licence alone.
  line.margin = line.resale - line.due;
  line.due += line.extraCredits;
  return line;
}

// ----------------------------------------------------------------------------
// Dunning
// ----------------------------------------------------------------------------

export type DunningStage = 'current' | 'past_due' | 'final_warning' | 'suspended';

/**
 * Where an unpaid invoice stands, counted in whole days from its due date:
 * `past_due` from `pastDueAfterDays`, a final warning 7 days before
 * `readOnlyAfterDays`, `suspended` (workspaces read-only) from
 * `readOnlyAfterDays`. While a staff pause is in force the clock is held at
 * `current`.
 */
export function dunningStage(input: {
  dueAt: Date;
  now: Date;
  pastDueAfterDays: number;
  readOnlyAfterDays: number;
  pausedUntil?: Date | null;
}): { stage: DunningStage; daysOverdue: number } {
  const daysOverdue = Math.max(0, Math.floor((input.now.getTime() - input.dueAt.getTime()) / DAY_MS));
  if (input.pausedUntil && input.pausedUntil.getTime() > input.now.getTime()) {
    return { stage: 'current', daysOverdue };
  }
  if (daysOverdue >= input.readOnlyAfterDays) return { stage: 'suspended', daysOverdue };
  if (daysOverdue >= Math.max(input.pastDueAfterDays, input.readOnlyAfterDays - 7)) {
    return { stage: 'final_warning', daysOverdue };
  }
  if (daysOverdue >= input.pastDueAfterDays) return { stage: 'past_due', daysOverdue };
  return { stage: 'current', daysOverdue };
}

/** Partner status for a dunning stage (the final warning is still `past_due`). */
export function partnerStatusForStage(stage: DunningStage): PartnerStatus {
  if (stage === 'suspended') return 'suspended';
  if (stage === 'current') return 'active';
  return 'past_due';
}

// ============================================================================
// Partner portal response shapes (app-api `/api/partner/*`)
// ============================================================================

/** `GET /api/partner/overview`. `currentMonth` needs `billing:read`, else null. */
export interface PartnerOverview {
  partner: PartnerPublicInfo & { status: PartnerStatus };
  role: PartnerMemberRole;
  /** Null while the partner has no contract in force. */
  contract: PartnerContractView | null;
  workspaceCount: number;
  activeWorkspaceCount: number;
  currentMonth: { totalResale: string; totalDue: string; totalMargin: string; currency: string } | null;
  /** Active licences whose balance is at or below 20% of the monthly allowance. */
  nearCreditLimit: Array<{ workspaceId: string; name: string; creditBalance: number; monthlyCredits: number }>;
}

/** `GET /api/partner/workspaces/:id`. */
export interface ManagedWorkspaceDetail extends ManagedWorkspaceRow {
  history: LicenceChangeView[];
}

/** A licence package (`/api/partner/packages`). */
export interface PartnerLicencePackageView {
  id: string;
  partnerId: string;
  name: string;
  description: string | null;
  allowedApps: string[];
  monthlyCredits: number;
  maxSeats: number | null;
  featurePlanId: string | null;
  storageGb: number | null;
  defaultResalePricing: ResalePricing;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/partner/catalog`. */
export interface PartnerCatalog {
  apps: Array<{ code: string; name: string; icon: string }>;
  featurePlans: Array<{ id: string; name: string; slug: string }>;
}

/** A territory workspace request (`/api/partner/requests`). */
export interface PartnerWorkspaceRequestView {
  id: string;
  partnerId: string;
  requesterUserId: string | null;
  requesterEmail: string;
  requesterName: string | null;
  companyName: string;
  countryCode: string;
  selectedApps: string[];
  message: string | null;
  status: PartnerRequestStatus;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A portal user (`/api/partner/team`). */
export interface PartnerTeamMember {
  id: string;
  email: string;
  role: PartnerMemberRole;
  /** Null until the invitee first opens the portal. */
  userId: string | null;
  acceptedAt: string | null;
  name: string | null;
}

/**
 * `POST /api/partner/workspaces/:id/credits`. `amount` is the number of credits
 * granted; `charge` is what the grant adds to this month's statement, in the
 * contract currency.
 */
export interface PartnerCreditGrantResult {
  newBalance: number;
  amount: number;
  charge: string;
}
