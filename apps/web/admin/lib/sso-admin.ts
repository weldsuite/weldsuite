// Client-safe helpers for the single sign-on card on the workspace billing tab.
// The rules mirror the billing worker's grantSsoPrice / revokeSsoAddon
// (apps/workers/billing-worker/src/services/sso-billing.ts), which stays the
// authority: these only decide what the console offers.

import {
  SSO_MAX_PRICE_CENTS,
  SSO_PRICE_CURRENCIES,
  type SsoAdminView,
  type SsoPriceCurrency,
} from '@weldsuite/app-api-client/schemas/sso';

/** List price, a staff price for this workspace, or free. */
export type SsoPriceMode = 'list' | 'custom' | 'free';

/** Body of `POST .../sso/grant`, without the reason. */
export interface SsoGrantRequest {
  /** null = the list price, 0 = free. */
  priceCents: number | null;
  currency: SsoPriceCurrency | null;
  switchOn: boolean;
}

/**
 * An amount typed in major units to minor units: "75" → 7500, "49.50" → 4950,
 * "49,5" → 4950. Null when it is not a plain amount with at most two decimals.
 * Integer arithmetic, so no float rounding creeps in.
 */
export function parseMajorUnitsToCents(input: string): number | null {
  const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** 7500 → "75", 4950 → "49.50": a saved price as the amount field shows it. */
export function centsToMajorUnits(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`;
}

export type CustomPriceProblem = 'format' | 'zero' | 'too_high';

/** Why a custom price cannot be saved, or null when it can. Zero is Free, a mode of its own. */
export function customPriceProblem(cents: number | null): CustomPriceProblem | null {
  if (cents === null) return 'format';
  if (cents === 0) return 'zero';
  if (cents > SSO_MAX_PRICE_CENTS) return 'too_high';
  return null;
}

export function isSsoPriceCurrency(value: string | null | undefined): value is SsoPriceCurrency {
  return (SSO_PRICE_CURRENCIES as readonly string[]).includes(value ?? '');
}

/**
 * The add-on subscription while it still exists in Stripe: active, retrying a
 * payment, or unpaid (SSO off until the overdue invoice is paid; it can still
 * be repriced or revoked).
 */
export function liveSsoSubscription(view: SsoAdminView): SsoAdminView['subscription'] {
  const sub = view.subscription;
  return sub && sub.status !== 'canceled' ? sub : null;
}

/** The mode the price dialog opens with: what is saved now. Partner-managed workspaces can only be free. */
export function initialPriceMode(view: SsoAdminView): SsoPriceMode {
  if (view.billingMode === 'partner') return 'free';
  const cents = view.priceOverride?.unitAmountCents;
  if (cents === 0) return 'free';
  if (cents != null && cents > 0) return 'custom';
  return 'list';
}

/** The custom price's currency to start with: the saved price's, else the customer's list price's. */
export function initialPriceCurrency(view: SsoAdminView): SsoPriceCurrency {
  const saved = view.priceOverride?.currency?.toLowerCase();
  if (isSsoPriceCurrency(saved)) return saved;
  const list = view.listPrice.currency.toLowerCase();
  return isSsoPriceCurrency(list) ? list : 'eur';
}

/**
 * Whether "switch SSO on now" makes sense: a paid price, a directly billed
 * workspace whose plan does not include SSO, and no add-on running yet (a
 * running one is repriced instead).
 */
export function canOfferSwitchOn(view: SsoAdminView, mode: SsoPriceMode): boolean {
  return mode !== 'free' && view.billingMode !== 'partner' && !view.planIncludesSso && liveSsoSubscription(view) === null;
}

/** Revoking needs something to take away: a saved price (free included) or a running add-on. */
export function canRevokeSso(view: SsoAdminView): boolean {
  return view.priceOverride !== null || liveSsoSubscription(view) !== null;
}

/** The grant request for the dialog's fields, or null while a custom price is not valid. */
export function ssoGrantRequest(
  view: SsoAdminView,
  form: { mode: SsoPriceMode; cents: number | null; currency: SsoPriceCurrency; switchOn: boolean },
): SsoGrantRequest | null {
  const switchOn = form.switchOn && canOfferSwitchOn(view, form.mode);
  switch (form.mode) {
    case 'free':
      return { priceCents: 0, currency: null, switchOn: false };
    case 'list':
      return { priceCents: null, currency: null, switchOn };
    case 'custom':
      if (form.cents === null || customPriceProblem(form.cents)) return null;
      return { priceCents: form.cents, currency: form.currency, switchOn };
  }
}

export type ConnectionInactiveReason = 'domain' | 'entitlement' | 'pending';

/**
 * Why a connection the workspace switched on is not active in Clerk, or null
 * when that does not apply. Clerk's `active` is kept equal to "switched on,
 * domain verified and entitled" (`desiredClerkActive` in @weldsuite/core-domain/sso);
 * when all three hold the hourly sweep has not caught up yet.
 */
export function connectionInactiveReason(view: SsoAdminView): ConnectionInactiveReason | null {
  const connection = view.connection;
  if (!connection?.enabled || connection.active) return null;
  if (!view.domain?.verified) return 'domain';
  if (!view.entitlement.entitled) return 'entitlement';
  return 'pending';
}
