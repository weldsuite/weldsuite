/**
 * Plan price and VAT helpers for the Plans page (`billing-settings-section.tsx`),
 * the Billing page and the seats dialog (`components/billing/manage-seats.tsx`).
 */

/** What `hasPaidPlan` reads: Global's and Mollie's subscription both fit. */
export interface PlanOfSubscription {
  planId?: string | null;
  planSlug?: string | null;
  /** Mollie only: cents per cycle, before VAT. */
  pricePerCycle?: number;
}

/**
 * Whether a paid plan is running. Mollie's subscription says what it costs
 * (`pricePerCycle`); Global's has no such field, so there a plan other than
 * Free counts. A legacy $0 subscription is no plan.
 */
export function hasPaidPlan(subscription: PlanOfSubscription | null | undefined): boolean {
  if (!subscription) return false;
  if (typeof subscription.pricePerCycle === 'number') return subscription.pricePerCycle > 0;
  return !!subscription.planId && (subscription.planSlug ?? 'free').toLowerCase() !== 'free';
}

/** Cents as a price: whole amounts drop the decimals (`€49`), others keep two (`€42.50`). */
export function formatPlanPrice(cents: number, currency: string = 'USD'): string {
  const amount = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * The VAT on `net` cents at `rateBps` (2100 is 21%), rounded half up: how the
 * server totals a charge line (`vat_of`, rust/modules/core-billing/src/vat.rs),
 * so the summary shows the amount Mollie charges.
 */
export function vatOfCents(net: number, rateBps: number): number {
  if (net <= 0 || rateBps <= 0) return 0;
  return Math.floor((net * rateBps + 5000) / 10000);
}

/** `21`, `25.5` (`25,5` in Dutch): a rate in basis points as a percentage. */
export function vatRateText(rateBps: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(rateBps / 100);
}

/** A country's name in the UI language (`NL` → "Netherlands"), else its code. */
export function countryName(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
