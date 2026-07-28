/**
 * Domain prices cross the wire in **cents**, not currency units.
 *
 * Cloudflare's registrar returns a decimal amount ("currency units, not cents"
 * — see `DomainSearchResult.price` in `@weldsuite/cloudflare-registrar`), and
 * app-api's `applyMarkup()` multiplies it by 100 so the value can go straight
 * to Stripe as `unit_amount`. The search UI used to render that integer with
 * `.toFixed(2)`, which showed a $10.46 `.com` as "US$ 1046.00" while checkout
 * charged the correct $10.46.
 *
 * The currency also travels with the result — the UI used to hardcode "US$"
 * even though app-api defaults to EUR.
 */

/**
 * Format a cents amount as a localized currency string.
 *
 * @returns `null` when there is no price to show, so callers can render their
 *   own "unavailable" copy and disable the buy action rather than displaying a
 *   made-up figure.
 */
export function formatDomainPrice(
  cents: number | null | undefined,
  currency: string | null | undefined,
  locale: string,
): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;

  const code = (currency ?? 'EUR').toUpperCase();
  const amount = cents / 100;

  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(amount);
  } catch {
    // Intl throws on a malformed ISO 4217 code. Registrar responses are the
    // only source of `currency`, so this should not happen — but a pricing
    // screen that throws is worse than one that renders "USD 10.46".
    return `${code} ${amount.toFixed(2)}`;
  }
}
