// Client-safe rules for a workspace's seat price on Mollie (the Kubernetes
// editions, ADR BILL-014): what the console offers and what the server write
// (actions/seat-price.server.ts) accepts. The Rust billing charges
// `billing_accounts.unit_amount` on every renewal, and on seats added between
// renewals, until the plan or the billing cycle changes; then the new plan's
// list price takes over (rust/modules/core-billing/src/renewals.rs, engine.rs).

import type { MollieBillingAccount, PlanOption, WorkspaceBilling } from './billing-types';
import { parseMajorUnitsToCents } from './sso-admin';

/** The most staff may set a seat to, per billing cycle: €10,000. */
export const MAX_SEAT_PRICE_CENTS = 1_000_000;

/** The one currency the Rust billing sells plans in (core-billing `plans::CURRENCY`). */
export const SEAT_PRICE_CURRENCY = 'EUR';

/** Subscription states the renewal job charges (core-billing `RUNNING_STATUSES`). */
const RUNNING_STATUSES = new Set(['active', 'trialing', 'past_due']);

type PricedPlan = Pick<PlanOption, 'slug' | 'priceMonthly' | 'priceYearly' | 'currency'>;

/** "25.00" → 2500; anything unreadable → 0, as the Rust billing reads an unpriced plan. */
function decimalCents(text: string | null | undefined): number {
  const value = Number.parseFloat(text ?? '');
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/**
 * The plan's list price per seat for `cycle`, in cents before VAT, as the
 * Rust billing reads it (core-billing `Plan::unit_amount`): EUR plans only, a
 * yearly price of 0 is twelve months, and Free or an unpriced ("on request")
 * plan has none.
 */
export function listSeatPrice(plan: PricedPlan | null | undefined, cycle: string | null | undefined): number | null {
  if (!plan || plan.slug === 'free' || plan.currency.toUpperCase() !== SEAT_PRICE_CURRENCY) return null;
  const monthly = decimalCents(plan.priceMonthly);
  const amount = cycle === 'yearly' ? decimalCents(plan.priceYearly) || monthly * 12 : monthly;
  return amount > 0 ? amount : null;
}

export type SeatPriceRefusal = 'not_found' | 'no_subscription' | 'not_eur';

/** What the write reads: the workspace and its `billing_accounts` row. */
export interface SeatPriceState {
  workspace: {
    planId: string | null;
    subscriptionStatus: string | null;
    subscriptionCurrentPeriodEnd: Date | null;
    deletedAt: Date | null;
  } | null;
  account: { unitAmount: number | null; currency: string; nextChargeAt: Date | null } | null;
}

/**
 * Why the seat price can't be set, or null when it can: the workspace runs a
 * paid subscription on Mollie (core-billing `has_running_subscription`, and a
 * next charge) priced in EUR.
 */
export function seatPriceRefusal({ workspace, account }: SeatPriceState, now: Date): SeatPriceRefusal | null {
  if (!workspace || workspace.deletedAt) return 'not_found';
  const periodEnd = workspace.subscriptionCurrentPeriodEnd;
  const running =
    workspace.planId !== null &&
    RUNNING_STATUSES.has(workspace.subscriptionStatus ?? '') &&
    periodEnd !== null &&
    periodEnd > now;
  if (!running || account?.unitAmount == null || account.nextChargeAt === null) return 'no_subscription';
  if (account.currency.toUpperCase() !== SEAT_PRICE_CURRENCY) return 'not_eur';
  return null;
}

/** Whether the Mollie card offers the dialog: {@link seatPriceRefusal} on what the page loaded. */
export function canAdjustSeatPrice(account: MollieBillingAccount, billing: WorkspaceBilling, now: Date): boolean {
  const date = (iso: string | null) => (iso ? new Date(iso) : null);
  const state: SeatPriceState = {
    workspace: {
      planId: billing.planId,
      subscriptionStatus: billing.subscriptionStatus,
      subscriptionCurrentPeriodEnd: date(billing.currentPeriodEnd),
      deletedAt: null,
    },
    account: { unitAmount: account.unitAmount, currency: account.currency, nextChargeAt: date(account.nextChargeAt) },
  };
  return seatPriceRefusal(state, now) === null;
}

export type SeatPriceProblem = 'format' | 'too_high' | 'unchanged';

/**
 * Why a price in cents can't be saved over `current`, or null when it can.
 * Zero is a price: renewals then charge nothing for the seats (no plan line),
 * while add-ons are still charged and the plan's credits still come.
 */
export function seatPriceProblem(cents: number | null, current: number | null): SeatPriceProblem | null {
  if (cents === null || !Number.isInteger(cents) || cents < 0) return 'format';
  if (cents > MAX_SEAT_PRICE_CENTS) return 'too_high';
  if (cents === current) return 'unchanged';
  return null;
}

/** {@link seatPriceProblem} for what was typed ("20", "19.50", "19,5"). */
export function typedSeatPriceProblem(input: string, current: number | null): SeatPriceProblem | null {
  return seatPriceProblem(parseMajorUnitsToCents(input), current);
}

/**
 * How far `unit` is from the list price, as a fraction of it: 0.2 is 20%
 * below, -0.1 is 10% above. Null without a list price or when they match.
 */
export function offList(unit: number | null, list: number | null): number | null {
  if (unit == null || list == null || list <= 0 || unit === list) return null;
  return (list - unit) / list;
}

/** 0.2 → "20%", -0.125 → "12.5%": the size of {@link offList}, without its sign. */
export function formatOffList(fraction: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(fraction));
}
