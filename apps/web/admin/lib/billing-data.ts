import 'server-only';

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';
import type {
  AuditEventRow,
  CreditsSummary,
  InvoiceRow,
  PaymentRow,
  PlanDetail,
  PlanOption,
  WorkspaceBilling,
} from './billing-types';

const {
  workspaces,
  plans,
  billingInvoices,
  billingPayments,
  workspaceCredits,
  creditTransactions,
  adminAuditEvents,
} = masterSchema;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export async function getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBilling | null> {
  const db = getMasterDb();
  const [row] = await db
    .select({
      workspace: workspaces,
      planName: plans.name,
    })
    .from(workspaces)
    .leftJoin(plans, eq(workspaces.planId, plans.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) return null;
  const w = row.workspace;

  return {
    workspaceId: w.id,
    planId: w.planId,
    planName: row.planName,
    purchasedSeats: w.purchasedSeats,
    subscriptionStatus: w.subscriptionStatus,
    subscriptionCycle: w.subscriptionCycle,
    currentPeriodEnd: iso(w.subscriptionCurrentPeriodEnd),
    cancelAtPeriodEnd: w.subscriptionCancelAtPeriodEnd,
    stripeCustomerId: w.stripeCustomerId,
    stripeSubscriptionId: w.stripeSubscriptionId,
    paidPlanRequired: w.paidPlanRequired,
    trialExpiredAt: iso(w.trialExpiredAt),
    paywallDeletionAt: w.deletionRequestedBy ? null : iso(w.scheduledDeletionAt),
    comp: w.compGrantedAt
      ? {
          grantedAt: w.compGrantedAt.toISOString(),
          endsAt: iso(w.compEndsAt),
          grantedBy: w.compGrantedBy,
          reason: w.compReason,
        }
      : null,
  };
}

function toPlanOption(p: typeof plans.$inferSelect): PlanOption {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    priceMonthly: p.priceMonthly,
    priceYearly: p.priceYearly,
    currency: p.currency,
    maxUsers: p.maxUsers,
    hasMonthlyPrice: Boolean(p.stripePriceIdMonthly),
    hasYearlyPrice: Boolean(p.stripePriceIdYearly),
    isActive: p.isActive,
  };
}

/** Every plan that is not deleted, active ones first (hidden plans can still be assigned). */
export async function listPlanOptions(): Promise<PlanOption[]> {
  const rows = await getMasterDb()
    .select()
    .from(plans)
    .where(isNull(plans.deletedAt))
    .orderBy(desc(plans.isActive), asc(plans.sortOrder), asc(plans.name));
  return rows.map(toPlanOption);
}

const workspaceCount = sql<number>`(
  select count(*)::int from ${workspaces}
  where ${workspaces.planId} = ${plans.id} and ${workspaces.deletedAt} is null
)`;

function toPlanDetail(p: typeof plans.$inferSelect, count: number): PlanDetail {
  return {
    ...toPlanOption(p),
    description: p.description,
    pricePerUser: p.pricePerUser,
    includedUsers: p.includedUsers,
    monthlyCredits: p.monthlyCredits ?? 0,
    creditsRolloverCap: p.creditsRolloverCap,
    maxProjects: p.maxProjects,
    maxCustomDomains: p.maxCustomDomains,
    removeBranding: p.removeBranding,
    hasApiAccess: p.hasApiAccess,
    isDefault: p.isDefault,
    sortOrder: p.sortOrder,
    badge: p.badge,
    color: p.color,
    features: (p.features ?? {}) as Record<string, unknown>,
    stripeProductId: p.stripeProductId,
    stripePriceIdMonthly: p.stripePriceIdMonthly,
    stripePriceIdYearly: p.stripePriceIdYearly,
    workspaceCount: count,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function listPlanDetails(): Promise<PlanDetail[]> {
  const rows = await getMasterDb()
    .select({ plan: plans, count: workspaceCount })
    .from(plans)
    .where(isNull(plans.deletedAt))
    .orderBy(asc(plans.sortOrder), asc(plans.name));
  return rows.map((r) => toPlanDetail(r.plan, Number(r.count ?? 0)));
}

export async function getPlanDetail(planId: string): Promise<PlanDetail | null> {
  const [row] = await getMasterDb()
    .select({ plan: plans, count: workspaceCount })
    .from(plans)
    .where(and(eq(plans.id, planId), isNull(plans.deletedAt)))
    .limit(1);
  return row ? toPlanDetail(row.plan, Number(row.count ?? 0)) : null;
}

const LEDGER_LIMIT = 25;

export async function getCreditsSummary(workspaceId: string): Promise<CreditsSummary> {
  const db = getMasterDb();
  const [[wallet], transactions] = await Promise.all([
    db
      .select({
        balance: workspaceCredits.currentBalance,
        monthlyAllocation: workspaceCredits.monthlyAllocation,
        periodEnd: workspaceCredits.periodEnd,
      })
      .from(workspaceCredits)
      .where(eq(workspaceCredits.workspaceId, workspaceId))
      .limit(1),
    db
      .select({
        id: creditTransactions.id,
        type: creditTransactions.type,
        amount: creditTransactions.amount,
        balanceAfter: creditTransactions.balanceAfter,
        description: creditTransactions.description,
        createdAt: creditTransactions.createdAt,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.workspaceId, workspaceId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(LEDGER_LIMIT),
  ]);

  return {
    balance: wallet?.balance ?? 0,
    monthlyAllocation: wallet?.monthlyAllocation ?? 0,
    periodEnd: iso(wallet?.periodEnd),
    transactions: transactions.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
  };
}

const HISTORY_LIMIT = 50;

export async function listWorkspaceInvoices(workspaceId: string): Promise<InvoiceRow[]> {
  const rows = await getMasterDb()
    .select({
      id: billingInvoices.id,
      number: billingInvoices.number,
      status: billingInvoices.status,
      amountDue: billingInvoices.amountDue,
      amountPaid: billingInvoices.amountPaid,
      currency: billingInvoices.currency,
      pdfUrl: billingInvoices.pdfUrl,
      hostedUrl: billingInvoices.hostedUrl,
      createdAt: billingInvoices.createdAt,
    })
    .from(billingInvoices)
    .where(eq(billingInvoices.workspaceId, workspaceId))
    .orderBy(desc(billingInvoices.createdAt))
    .limit(HISTORY_LIMIT);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function listWorkspacePayments(workspaceId: string): Promise<PaymentRow[]> {
  const rows = await getMasterDb()
    .select({
      id: billingPayments.id,
      amount: billingPayments.amount,
      currency: billingPayments.currency,
      status: billingPayments.status,
      refundedAmount: billingPayments.refundedAmount,
      methodType: billingPayments.paymentMethodType,
      methodBrand: billingPayments.paymentMethodBrand,
      methodLast4: billingPayments.paymentMethodLast4,
      createdAt: billingPayments.createdAt,
    })
    .from(billingPayments)
    .where(eq(billingPayments.workspaceId, workspaceId))
    .orderBy(desc(billingPayments.createdAt))
    .limit(HISTORY_LIMIT);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export interface AuditFilter {
  workspaceId?: string;
  plan?: string;
  limit?: number;
}

export async function listAuditEvents(filter: AuditFilter = {}): Promise<AuditEventRow[]> {
  const where = filter.workspaceId
    ? eq(adminAuditEvents.workspaceId, filter.workspaceId)
    : filter.plan
      ? and(eq(adminAuditEvents.targetType, 'plan'), eq(adminAuditEvents.targetId, filter.plan))
      : undefined;

  const rows = await getMasterDb()
    .select({
      id: adminAuditEvents.id,
      workspaceId: adminAuditEvents.workspaceId,
      targetType: adminAuditEvents.targetType,
      targetId: adminAuditEvents.targetId,
      action: adminAuditEvents.action,
      outcome: adminAuditEvents.outcome,
      actorEmail: adminAuditEvents.actorEmail,
      reason: adminAuditEvents.reason,
      error: adminAuditEvents.error,
      createdAt: adminAuditEvents.createdAt,
    })
    .from(adminAuditEvents)
    .where(where)
    .orderBy(desc(adminAuditEvents.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
