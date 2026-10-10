/**
 * Plan prices per country — shared Zod v3 contract.
 *
 * Paid plan prices (Business, Scale, Enterprise) are not published by
 * default: everywhere a price would show (platform billing, plan pickers,
 * the marketing pricing page) it reads "On request". An admin can set the
 * prices for specific countries in the admin console (`/plan-pricing`); a
 * visitor or workspace in one of those countries then sees that country's
 * prices, in that country's currency. Free is always free and never listed.
 *
 * Storage: the master DB `system_settings` row `billing.plan_country_pricing`
 * (category `billing`, JSON), shape {@link PlanCountryPricingConfig}.
 *
 * Readers: app-api (`GET /api/billing/plans/prices`, for the platform), the
 * admin console (editor) and the marketing site (weldsuite-marketing
 * `lib/pricing.ts`, which keeps a copy of {@link resolveCountryPlanPrices}
 * because it lives in another repository — keep the two in sync).
 */

import { z } from 'zod';

/** `system_settings.key` holding the per-country price list. */
export const PLAN_COUNTRY_PRICING_KEY = 'billing.plan_country_pricing';

/** Plans whose price can be set per country. Free is always 0, everywhere. */
export const PRICED_PLAN_SLUGS = ['business', 'scale', 'enterprise'] as const;
export type PricedPlanSlug = (typeof PRICED_PLAN_SLUGS)[number];

/** Highest per-seat monthly price accepted, a guard against a typo'd extra zero or two. */
export const MAX_PLAN_PRICE = 100_000;

const hasAtMostTwoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

const priceSchema = z
  .number()
  .gt(0)
  .max(MAX_PLAN_PRICE)
  .refine(hasAtMostTwoDecimals, { message: 'At most 2 decimals' });

/** One plan's price in one country, per user per month. */
export const countryPlanPriceSchema = z
  .object({
    /** Per user per month on monthly billing. */
    monthly: priceSchema,
    /** Per user per month when billed annually; `null` = no annual option shown. */
    annual: priceSchema.nullable(),
  })
  .refine((p) => p.annual === null || p.annual <= p.monthly, {
    message: 'The annual price cannot be higher than the monthly price',
    path: ['annual'],
  });
export type CountryPlanPrice = z.infer<typeof countryPlanPriceSchema>;

/** ISO 3166-1 alpha-2, upper case (`NL`, `BE`, `US`). */
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

/** ISO 4217, upper case (`EUR`, `USD`, `GBP`). */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

/** The prices for one country. A plan left out stays "On request" there. */
export const countryPricingSchema = z.object({
  currency: currencyCodeSchema,
  plans: z.object({
    business: countryPlanPriceSchema.optional(),
    scale: countryPlanPriceSchema.optional(),
    enterprise: countryPlanPriceSchema.optional(),
  }),
});
export type CountryPricing = z.infer<typeof countryPricingSchema>;

/** Stored value of the `billing.plan_country_pricing` setting. */
export const planCountryPricingConfigSchema = z.object({
  countries: z.record(countryCodeSchema, countryPricingSchema),
});
export type PlanCountryPricingConfig = z.infer<typeof planCountryPricingConfigSchema>;

export const EMPTY_PLAN_COUNTRY_PRICING: PlanCountryPricingConfig = { countries: {} };

/**
 * Parse a stored value leniently: a malformed country entry is dropped (so
 * it shows "On request") instead of taking every other country down with it.
 */
export function parsePlanCountryPricing(value: unknown): PlanCountryPricingConfig {
  if (!value || typeof value !== 'object') return EMPTY_PLAN_COUNTRY_PRICING;
  const raw = (value as { countries?: unknown }).countries;
  if (!raw || typeof raw !== 'object') return EMPTY_PLAN_COUNTRY_PRICING;
  const countries: Record<string, CountryPricing> = {};
  for (const [code, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!countryCodeSchema.safeParse(code).success) continue;
    const parsed = countryPricingSchema.safeParse(entry);
    if (parsed.success) countries[code] = parsed.data;
  }
  return { countries };
}

/** Normalise a country hint (`nl`, ` NL `) to `NL`, or `null` when it is not a usable code. */
export function normalizeCountryCode(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? '';
  // `XX` / `T1` are Cloudflare's "unknown" and "Tor" markers.
  if (code === 'XX' || code === 'T1') return null;
  return countryCodeSchema.safeParse(code).success ? code : null;
}

/** What a caller in one country sees. A `null` plan price means "On request". */
export interface ResolvedPlanPrices {
  /** The country the prices were resolved for, `null` when it is unknown. */
  country: string | null;
  /** Currency of the prices below, `null` when nothing is priced. */
  currency: string | null;
  plans: Record<PricedPlanSlug, CountryPlanPrice | null>;
}

/**
 * The plan prices to show a caller in `country`. Countries without an entry,
 * and plans a country entry leaves out, resolve to `null` ("On request").
 */
export function resolveCountryPlanPrices(
  config: PlanCountryPricingConfig,
  country: string | null | undefined,
): ResolvedPlanPrices {
  const code = normalizeCountryCode(country);
  const entry = code ? config.countries[code] : undefined;
  return {
    country: code,
    currency: entry ? entry.currency : null,
    plans: {
      business: entry?.plans.business ?? null,
      scale: entry?.plans.scale ?? null,
      enterprise: entry?.plans.enterprise ?? null,
    },
  };
}

/** Response of `GET /api/billing/plans/prices`. */
export const resolvedPlanPricesSchema = z.object({
  country: countryCodeSchema.nullable(),
  currency: currencyCodeSchema.nullable(),
  plans: z.object({
    business: countryPlanPriceSchema.nullable(),
    scale: countryPlanPriceSchema.nullable(),
    enterprise: countryPlanPriceSchema.nullable(),
  }),
});
