// Client-safe billing types for the admin console. The server-only readers in
// billing-data.ts and the billing-worker client produce these; the billing UI
// (client components) consumes them. Shapes from the worker mirror
// apps/workers/billing-worker/src/services/admin-billing.ts.

export type SubscriptionCycle = 'monthly' | 'yearly';
export type ProrationBehavior = 'always_invoice' | 'create_prorations' | 'none';
export type CollectionMethod = 'charge_automatically' | 'send_invoice';

export interface WorkspaceComp {
  grantedAt: string;
  endsAt: string | null;
  grantedBy: string | null;
  reason: string | null;
}

/** Billing state mirrored on the master `workspaces` row. */
export interface WorkspaceBilling {
  workspaceId: string;
  planId: string | null;
  planName: string | null;
  purchasedSeats: number;
  subscriptionStatus: string | null;
  subscriptionCycle: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  paidPlanRequired: boolean;
  trialExpiredAt: string | null;
  /** Only the trial-expiry policy's schedule; an admin deletion is shown elsewhere. */
  paywallDeletionAt: string | null;
  comp: WorkspaceComp | null;
}

/** A plan as offered in the plan pickers. */
export interface PlanOption {
  id: string;
  name: string;
  slug: string;
  priceMonthly: string;
  priceYearly: string;
  currency: string;
  maxUsers: number | null;
  hasMonthlyPrice: boolean;
  hasYearlyPrice: boolean;
  isActive: boolean;
}

/** Full plan row for the catalog screens. */
export interface PlanDetail extends PlanOption {
  description: string | null;
  pricePerUser: string | null;
  includedUsers: number | null;
  monthlyCredits: number;
  creditsRolloverCap: number | null;
  maxProjects: number | null;
  maxCustomDomains: number | null;
  removeBranding: boolean;
  hasApiAccess: boolean;
  isDefault: boolean;
  sortOrder: number;
  badge: string | null;
  color: string | null;
  features: Record<string, unknown>;
  stripeProductId: string | null;
  stripePriceIdMonthly: string | null;
  stripePriceIdYearly: string | null;
  workspaceCount: number;
  updatedAt: string;
}

export interface CreditTransactionRow {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: string;
}

export interface CreditsSummary {
  balance: number;
  monthlyAllocation: number;
  periodEnd: string | null;
  transactions: CreditTransactionRow[];
}

export interface InvoiceRow {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number | null;
  amountPaid: number | null;
  currency: string | null;
  pdfUrl: string | null;
  hostedUrl: string | null;
  createdAt: string;
}

export interface PaymentRow {
  id: string;
  amount: number;
  currency: string;
  status: string;
  refundedAmount: number;
  methodType: string | null;
  methodBrand: string | null;
  methodLast4: string | null;
  createdAt: string;
}

export interface AuditEventRow {
  id: string;
  workspaceId: string | null;
  targetType: string;
  targetId: string;
  action: string;
  outcome: 'success' | 'failure';
  actorEmail: string;
  reason: string | null;
  error: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Live Stripe snapshot (GET /api/internal/admin/workspaces/:id/stripe)
// ---------------------------------------------------------------------------

export interface PaymentMethodSummary {
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface InvoiceSummary {
  id: string;
  status: string | null;
  amountDueCents: number;
  currency: string;
  hostedUrl: string | null;
}

export interface StripeSnapshot {
  customer: {
    id: string;
    email: string | null;
    name: string | null;
    balanceCents: number;
    currency: string | null;
    hasAddress: boolean;
    defaultPaymentMethod: PaymentMethodSummary | null;
  } | null;
  subscription: {
    id: string;
    status: string;
    priceId: string | null;
    unitAmountCents: number | null;
    currency: string | null;
    interval: string | null;
    quantity: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    cancelAt: string | null;
    trialEnd: string | null;
    collectionMethod: CollectionMethod;
    daysUntilDue: number | null;
    automaticTax: boolean;
    paymentMethod: PaymentMethodSummary | null;
    discount: {
      couponId: string;
      name: string | null;
      percentOff: number | null;
      amountOffCents: number | null;
      currency: string | null;
      duration: string;
      durationInMonths: number | null;
      endsAt: string | null;
    } | null;
    latestInvoice: InvoiceSummary | null;
  } | null;
  errors: string[];
}

/** Snapshot load result: the console may not be wired to the worker at all. */
export type SnapshotState =
  | { kind: 'ok'; snapshot: StripeSnapshot }
  | { kind: 'not_configured' }
  | { kind: 'error'; message: string };

export interface InvoicePreview {
  available: boolean;
  amountDueCents: number;
  currency: string;
  lines: Array<{ description: string; amountCents: number }>;
}

/** Results some billing actions return; `warnings` are shown as toasts. */
export interface WithWarnings {
  warnings?: string[];
}
