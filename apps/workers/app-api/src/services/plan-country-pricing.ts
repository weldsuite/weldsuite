/**
 * Plan prices per country for the platform's billing pages.
 *
 * Paid plans are "On request" unless an admin set prices for the caller's
 * country (admin console `/plan-pricing`, master `system_settings` row
 * `billing.plan_country_pricing`). The shape and resolver are shared with the
 * admin console and mirrored by the marketing site:
 * `@weldsuite/app-api-client/schemas/plan-country-pricing`.
 */

import { eq, isNull } from 'drizzle-orm';
import {
  EMPTY_PLAN_COUNTRY_PRICING,
  PLAN_COUNTRY_PRICING_KEY,
  PRICED_PLAN_SLUGS,
  normalizeCountryCode,
  parsePlanCountryPricing,
  resolveCountryPlanPrices,
  type CountryPlanPrice,
  type PlanCountryPricingConfig,
  type PricedPlanSlug,
  type ResolvedPlanPrices,
} from '@weldsuite/app-api-client/schemas/plan-country-pricing';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';

const { systemSettings } = masterSchema;

/** How long one isolate reuses the price list; matches the marketing site's 5-minute cache. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { config: PlanCountryPricingConfig; at: number } | null = null;

/** The saved per-country price list, memoised per isolate. A failed read means "everything on request". */
export async function getPlanCountryPricingConfig(masterDb: MasterDatabase): Promise<PlanCountryPricingConfig> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.config;
  try {
    const [row] = await masterDb
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, PLAN_COUNTRY_PRICING_KEY))
      .limit(1);
    const config = parsePlanCountryPricing(row?.value);
    cached = { config, at: Date.now() };
    return config;
  } catch (err) {
    console.warn('[plan-pricing] could not read plan_country_pricing, showing every plan on request', err);
    return EMPTY_PLAN_COUNTRY_PRICING;
  }
}

/** Test hook: forget the memoised price list. */
export function resetPlanCountryPricingCache(): void {
  cached = null;
}

/**
 * Country of the request as Cloudflare geolocates it (`request.cf.country`,
 * or the `CF-IPCountry` header when a proxy in front sets it).
 */
export function requestCountry(req: Request): string | null {
  const cf = (req as Request & { cf?: { country?: unknown } }).cf;
  const fromCf = typeof cf?.country === 'string' ? cf.country : null;
  return normalizeCountryCode(fromCf ?? req.headers.get('cf-ipcountry'));
}

/**
 * The workspace's billing country (Settings → Business), the same address
 * checkout pre-fills into Stripe. `null` when unset or unreadable.
 */
export async function workspaceBillingCountry(tenantDb: Database | undefined): Promise<string | null> {
  if (!tenantDb) return null;
  try {
    const [settings] = await tenantDb
      .select({ country: schema.workspaceSettings.country })
      .from(schema.workspaceSettings)
      .where(isNull(schema.workspaceSettings.deletedAt))
      .limit(1);
    return normalizeCountryCode(settings?.country);
  } catch {
    return null;
  }
}

/**
 * Which country's prices a platform caller sees: the workspace's billing
 * country when it has one, otherwise where the request comes from.
 */
export async function resolvePlanPricesForCaller(input: {
  masterDb: MasterDatabase;
  tenantDb: Database | undefined;
  req: Request;
}): Promise<ResolvedPlanPrices> {
  const [config, billingCountry] = await Promise.all([
    getPlanCountryPricingConfig(input.masterDb),
    workspaceBillingCountry(input.tenantDb),
  ]);
  return resolveCountryPlanPrices(config, billingCountry ?? requestCountry(input.req));
}

const isPricedSlug = (slug: string): slug is PricedPlanSlug =>
  (PRICED_PLAN_SLUGS as readonly string[]).includes(slug);

export type PlanDisplayPrice =
  | { kind: 'free' }
  | { kind: 'on_request' }
  | { kind: 'priced'; price: CountryPlanPrice; currency: string };

/**
 * What a plan row should show this caller. `free` is the zero-priced entry
 * plan; any other plan is `priced` only when the caller's country has a price
 * for it, else `on_request`. Plans outside the priced set (legacy slugs) are
 * on request too, so a forgotten row never leaks a database price.
 */
export function planDisplayPrice(slug: string, resolved: ResolvedPlanPrices): PlanDisplayPrice {
  if (slug === 'free') return { kind: 'free' };
  if (!isPricedSlug(slug)) return { kind: 'on_request' };
  const price = resolved.plans[slug];
  if (!price || !resolved.currency) return { kind: 'on_request' };
  return { kind: 'priced', price, currency: resolved.currency };
}
