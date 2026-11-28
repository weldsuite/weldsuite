// Client-safe billing types for the admin console. The server-only readers in
// billing-data.ts produce these; the billing UI (client components) consumes
// them.

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
  /**
   * Who issued the invoice: 'weldbooks' (ADR BILL-014), or 'stripe' on rows
   * from before Global moved into this install. A plain string, so a new provider reads as "not Stripe"
   * instead of failing.
   */
  provider: string;
  /** The Mollie payment (`tr_…`) a WeldBooks invoice was issued for; null on Stripe rows. */
  providerPaymentId: string | null;
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
  /** 'mollie', or 'stripe' on rows from before Global moved into this install. */
  provider: string;
  /** The Mollie payment (`tr_…`); null on Stripe rows. */
  providerPaymentId: string | null;
  /** What a Mollie charge was for: checkout, change, renewal, pay_link, mandate. */
  kind: string | null;
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
// Plan billing on Mollie (master `billing_accounts`, ADR BILL-014). Read-only here: changes run from `weldsuite admin billing`.
// ---------------------------------------------------------------------------

/** The charge a past-due account still has to pay (its `billing_payments` row). */
export interface MolliePastDueCharge {
  /** `billing_payments.id` (`bpy_…`). */
  id: string;
  /** The Mollie payment (`tr_…`), once it was sent to Mollie. */
  providerPaymentId: string | null;
  /** Null when the row is gone. */
  amount: number | null;
  currency: string | null;
  status: string | null;
  failureMessage: string | null;
}

export interface MollieBillingAccount {
  /** Mollie customer (`cst_…`). */
  customerId: string | null;
  /** The default mandate (`mdt_…`) renewals charge. */
  mandateId: string | null;
  /** creditcard, directdebit, paypal. */
  mandateMethod: string | null;
  /** Masked, e.g. "Visa •••• 4242". */
  mandateLabel: string | null;
  /** Net price per seat per cycle, in cents. */
  unitAmount: number | null;
  currency: string;
  /** Day of the month (1–28) charges fall on. */
  anchorDay: number | null;
  nextChargeAt: string | null;
  /** What changes at the end of the period; null when nothing is scheduled. */
  scheduled: {
    planId: string | null;
    planName: string | null;
    seats: number | null;
    cycle: string | null;
  } | null;
  /** Null unless the account is past due. */
  pastDue: {
    since: string;
    remindedAt: string | null;
    charge: MolliePastDueCharge | null;
  } | null;
}
