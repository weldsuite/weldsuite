/**
 * Billing Domain Types
 *
 * Response types for the settings billing surfaces.
 *
 * The live billing surface runs on app-api `/api/billing/*` (and credit
 * topup checkout on `/api/credits/checkout`) through `useAppApiClient()` +
 * `@/hooks/queries/use-billing-queries`. Phone subscription pricing is
 * proxied by app-api from billing-worker so the browser never calls it.
 */

// ============================================================================
// Response Types (app-api `/api/billing/*` payloads, unwrapped from `{ data }`)
// ============================================================================

/** A plan change that waits for the period end (Mollie only). */
export interface BillingScheduledChange {
  planId: string;
  planName: string;
  seats: number;
  cycle: 'monthly' | 'yearly';
  effectiveAt: string;
}

/** An unpaid, past-due charge (Mollie only). `amount` is in cents. */
export interface BillingOutstanding {
  amount: number;
  currency: string;
  payUrl: string;
  since: string;
}

/** Fields only a Mollie-billed subscription carries (`billingProvider` in `/config.json`). */
export interface BillingMollieFields {
  provider?: 'mollie';
  scheduledChange?: BillingScheduledChange | null;
  outstanding?: BillingOutstanding | null;
}

export interface BillingSubscriptionResponse extends BillingMollieFields {
  id: string;
  planId: string | null;
  planName: string;
  planSlug: string;
  status: string;
  cycle: 'monthly' | 'yearly';
  purchasedSeats: number;
  usedSeats: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /**
   * Post-trial paywall fields — the 14-day trial (or subscription) ended
   * without a payment method on file. `isLocked` is the single source of
   * truth for whether the app should render the full-screen paywall
   * (see `WorkspaceLockGate`); the workspace + all its data is permanently
   * deleted on `scheduledDeletionAt` unless a payment method is added.
   */
  paidPlanRequired: boolean;
  trialExpiredAt: string | null;
  scheduledDeletionAt: string | null;
  isLocked: boolean;
}

/**
 * Stripe phone-number subscription cost row for the billing page.
 * Served by app-api `GET /billing/phone-subscription` (proxied from
 * billing-worker).
 */
export interface PhoneSubscriptionResponse {
  exists: boolean;
  subscriptionId?: string;
  status?: string;
  items?: Array<{
    id: string;
    priceId: string;
    quantity: number;
    amount: number;
    currency: string;
    interval: string;
  }>;
  totalMonthly?: number;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
}

/**
 * A saved Stripe payment method. There is no local mirror table — this is
 * mapped straight off the Stripe API by app-api's `GET /billing/payment-methods`.
 *
 * `type` is one of `card` or `sepa_debit`; iDEAL and Bancontact are collected
 * as redirect methods but Stripe saves the resulting mandate as `sepa_debit`,
 * so they never appear as their own type here.
 */
export interface BillingPaymentMethodResponse {
  id: string;
  type: string;
  /** Card networks only (`visa`, `mastercard`, …); null for SEPA. */
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  country: string | null;
  /** SEPA only — the issuing bank code. */
  bankCode: string | null;
  holderName: string | null;
  /** Mollie: a display label such as `NL•• •••• 1234` for a SEPA mandate. */
  label?: string | null;
  /** Stripe's own default, resolved subscription-first. Exactly one is true. */
  isDefault: boolean;
  createdAt: string | null;
}

export interface BillingInvoiceResponse {
  id: string;
  number: string | null;
  amount: number;
  currency: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  pdfUrl: string | null;
  hostedUrl: string | null;
  createdAt: string | null;
  taxAmount: number;
  subtotalAmount: number;
  customerCountry: string | null;
  customerTaxExempt: string | null;
}

/** `GET /billing/checkout/:id`: how a Mollie billing checkout (`bpy_…`) ended. */
export interface BillingCheckoutStatusResponse {
  id: string;
  status: 'paid' | 'pending' | 'canceled' | 'expired' | 'failed' | 'unknown';
  purpose: 'checkout' | 'change' | 'mandate' | 'pay_link';
}

/** What `POST /billing/checkout` answers: a redirect, or a change made in place (Mollie). */
export interface BillingCheckoutResult {
  url?: string;
  success?: boolean;
  /** The change takes effect at the period end. */
  scheduled?: boolean;
  effectiveAt?: string;
  paymentRequired?: boolean;
  paymentUrl?: string | null;
}
