/**
 * Billing Domain Types
 *
 * Response types for the settings billing surfaces.
 *
 * The `billingApi` client that used to live here is gone. It talked to the
 * obsolete api-worker via the legacy worker client, but it was never exported —
 * nothing in the platform could reach it, so all ten of its calls were dead.
 * The live billing surface runs on app-api `/api/billing/*` through
 * `useAppApiClient()` + `@/hooks/queries/use-billing-queries`; these two
 * interfaces are all any consumer ever imported from this module.
 *
 * Phone billing operations remain in billing-worker-client.ts.
 */

// ============================================================================
// Response Types (app-api `/api/billing/*` payloads, unwrapped from `{ data }`)
// ============================================================================

export interface BillingSubscriptionResponse {
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
