import {
  PRICED_PLAN_SLUGS,
  countryCodeSchema,
  countryPricingSchema,
  currencyCodeSchema,
  type CountryPricing,
  type PricedPlanSlug,
} from '@weldsuite/app-api-client/schemas/plan-country-pricing';

/**
 * Plan prices per country: form parsing shared by the editor (client) and the
 * server actions. The stored shape, key and resolver live in
 * `@weldsuite/app-api-client/schemas/plan-country-pricing`.
 */

export { PRICED_PLAN_SLUGS, type PricedPlanSlug };

/** Raw text of one plan's two inputs. Both empty = the plan stays "On request". */
export interface PlanPriceInput {
  monthly: string;
  annual: string;
}

export interface CountryPricingInput {
  country: string;
  currency: string;
  plans: Record<PricedPlanSlug, PlanPriceInput>;
}

export type PlanPricingErrorCode =
  | 'country_invalid'
  | 'currency_invalid'
  | 'price_invalid'
  | 'annual_without_monthly'
  | 'annual_above_monthly';

export type CountryPricingParseResult =
  | { ok: true; country: string; pricing: CountryPricing }
  | { ok: false; code: PlanPricingErrorCode; plan?: PricedPlanSlug };

/** "49,50" and "49.50" both work; empty stays empty. */
function parseAmount(raw: string): number | null | 'invalid' {
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 'invalid';
}

/** Validate the add/edit dialog. Reports the first problem. */
export function parseCountryPricingInput(input: CountryPricingInput): CountryPricingParseResult {
  const country = input.country.trim().toUpperCase();
  if (!countryCodeSchema.safeParse(country).success) return { ok: false, code: 'country_invalid' };
  const currency = input.currency.trim().toUpperCase();
  if (!currencyCodeSchema.safeParse(currency).success) return { ok: false, code: 'currency_invalid' };

  const plans: CountryPricing['plans'] = {};
  for (const plan of PRICED_PLAN_SLUGS) {
    const monthly = parseAmount(input.plans[plan].monthly);
    const annual = parseAmount(input.plans[plan].annual);
    if (monthly === 'invalid' || annual === 'invalid') return { ok: false, code: 'price_invalid', plan };
    if (monthly === null) {
      if (annual !== null) return { ok: false, code: 'annual_without_monthly', plan };
      continue;
    }
    if (annual !== null && annual > monthly) return { ok: false, code: 'annual_above_monthly', plan };
    plans[plan] = { monthly, annual };
  }

  const parsed = countryPricingSchema.safeParse({ currency, plans });
  if (!parsed.success) {
    const plan = parsed.error.issues[0]?.path.find((p): p is PricedPlanSlug =>
      (PRICED_PLAN_SLUGS as readonly unknown[]).includes(p),
    );
    return { ok: false, code: 'price_invalid', plan };
  }
  return { ok: true, country, pricing: parsed.data };
}

/** Form text for a stored entry (or an empty form for a new country). */
export function toCountryPricingInput(country: string, pricing: CountryPricing | null): CountryPricingInput {
  const plans = {} as Record<PricedPlanSlug, PlanPriceInput>;
  for (const plan of PRICED_PLAN_SLUGS) {
    const price = pricing?.plans[plan];
    plans[plan] = {
      monthly: price ? String(price.monthly) : '',
      annual: price?.annual != null ? String(price.annual) : '',
    };
  }
  return { country, currency: pricing?.currency ?? 'EUR', plans };
}

/** `49` → `€49`, `42.5` → `€42.50`. Falls back to `42.50 XYZ` for a currency Intl does not know. */
export function formatPlanPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** English display name for a country code (`NL` → `Netherlands`), or the code itself. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
