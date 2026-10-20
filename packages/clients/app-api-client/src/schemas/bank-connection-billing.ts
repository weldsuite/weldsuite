/**
 * WeldBooks bank connections in the subscription: a plan includes a number of
 * bank connections (`plans.features.includedBankConnections`, default 1), and
 * every connection above that is billed monthly on its own Stripe
 * subscription (billing-worker `/api/billing/bank-connections`, quantity =
 * connections - included).
 *
 * One connection is one bank login, with every account at that bank: that is
 * how the aggregators charge (a Plaid Item, a Stripe FC institution). It counts
 * from the moment it is linked until it is disconnected or removed, also while
 * it waits for the user to sign in again, because the provider keeps charging
 * for it.
 */

import { z } from 'zod';

/** Bank connections a plan includes when its features don't say. */
export const DEFAULT_INCLUDED_BANK_CONNECTIONS = 1;

/** Price of one extra connection per month, in minor units. */
export const BANK_CONNECTION_EXTRA_PRICE_CENTS = 500;
/** The price's own currency; `usd` is added as a currency option for customers billed in dollars. */
export const BANK_CONNECTION_EXTRA_CURRENCY = 'eur';
export const BANK_CONNECTION_EXTRA_USD_PRICE_CENTS = 500;

/** Error codes books-api answers a connect with. */
export const BANK_CONNECTION_LIMIT_REACHED = 'BANK_CONNECTION_LIMIT_REACHED';
export const BANK_CONNECTION_PAYMENT_METHOD_REQUIRED = 'PAYMENT_METHOD_REQUIRED';
export const BANK_CONNECTION_BILLING_ADMIN_REQUIRED = 'BILLING_ADMIN_REQUIRED';

/** The plan's included connections: a non-negative whole number, else the default. */
export function resolveIncludedBankConnections(features: Record<string, unknown> | null | undefined): number {
  const value = features?.includedBankConnections;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : DEFAULT_INCLUDED_BANK_CONNECTIONS;
}

/** Billed extra connections for `connections` live ones. */
export function extraBankConnections(connections: number, included: number): number {
  return Math.max(0, connections - included);
}

export const bankConnectionBillingSummarySchema = z.object({
  /** Connections that count: linked and not disconnected or removed. */
  connections: z.number().int().nonnegative(),
  included: z.number().int().nonnegative(),
  /** Connections billed on top of the plan right now (the Stripe quantity). */
  billedExtra: z.number().int().nonnegative(),
  unitAmountCents: z.number().int().nonnegative(),
  currency: z.string(),
  hasPaymentMethod: z.boolean(),
  /** Whether the caller may take on an extra connection (workspace admins only). */
  canAddPaid: z.boolean(),
});
export type BankConnectionBillingSummary = z.infer<typeof bankConnectionBillingSummarySchema>;
