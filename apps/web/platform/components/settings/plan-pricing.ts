/**
 * Plan price and VAT helpers for the Plans page's checkout
 * (`billing-settings-section.tsx`), the Billing page and the seats dialog
 * (`components/billing/manage-seats.tsx`).
 */

/** What `hasPaidPlan` reads: Global's and Mollie's subscription both fit. */
export interface PlanOfSubscription {
  planId?: string | null;
  planSlug?: string | null;
  status?: string | null;
  /** `mollie` on a subscription billed through Mollie (the EU edition). */
  provider?: string | null;
  /** Mollie only: cents per cycle, before VAT, while a paid period runs. */
  pricePerCycle?: number;
}

/** A paid subscription on Global: running, the trial excluded. */
const PAID_STATUSES = new Set(['active', 'past_due']);

/**
 * Whether a paid plan is running, with seats to change. Mollie's subscription
 * sends its price only while a paid period runs: a comp, a trial and a plan
 * that ended into its grace period have none, and changing their seats is
 * refused. Global sends no price, so there an active or past-due plan other
 * than Free counts.
 */
export function hasPaidPlan(subscription: PlanOfSubscription | null | undefined): boolean {
  if (!subscription) return false;
  if (subscription.provider === 'mollie') return (subscription.pricePerCycle ?? 0) > 0;
  return (
    !!subscription.planId &&
    (subscription.planSlug ?? 'free').toLowerCase() !== 'free' &&
    PAID_STATUSES.has(subscription.status ?? '')
  );
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
