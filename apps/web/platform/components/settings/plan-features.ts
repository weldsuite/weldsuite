import type { Billing } from '@/lib/api/types/apps/billing.types';

// Curated feature lists per plan, keyed by plan slug. The seat limit and the
// apps line are not listed here: they are derived from the plan itself (see
// `planCardFeatures`) so they can never disagree with what is enforced.
export const PLAN_FEATURES: Record<string, string[]> = {
  free: [
    '100 credits included',
    '1,000 emails per month',
    'Unlimited contacts',
    'Passkey sign-in',
  ],
  business: [
    '250 GB storage per user',
    'API access & webhooks',
    'Custom email domains',
    'Roles & permissions',
    'Standard support',
  ],
  scale: [
    '1 TB storage per user',
    'Priority support',
    'Advanced roles & permissions',
    '90-day automation history',
    'Call & meeting intelligence',
  ],
  enterprise: [
    'SSO / SAML',
    '99.999% uptime SLA',
    'Data residency',
    'Dedicated support',
    'Custom integrations',
  ],
};

// The slug is the stable key; the lowercased display name is only a fallback.
export function resolvePlanKey(plan: Pick<Billing.BillingPlan, 'slug' | 'name'>, known: Record<string, unknown>): string {
  if (plan.slug && plan.slug in known) return plan.slug;
  return plan.name.toLowerCase();
}

export function formatPlanFeatures(plan: Pick<Billing.BillingPlan, 'slug' | 'name'>): string[] {
  return PLAN_FEATURES[resolvePlanKey(plan, PLAN_FEATURES)] ?? [];
}

/** Replaces `{name}` placeholders in a locale string. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/**
 * What the plan allows, from `plan.maxMembers` (the `plans.max_users` column
 * the invite path and Clerk's seat cap enforce). `null` is unlimited, except
 * on Enterprise, where it is agreed per contract.
 */
export type PlanSeatLimit =
  | { kind: 'exact'; count: 1 }
  | { kind: 'upTo'; count: number }
  | { kind: 'unlimited' }
  | { kind: 'custom' };

export function planSeatLimit(plan: Pick<Billing.BillingPlan, 'slug' | 'maxMembers'>): PlanSeatLimit {
  const max = plan.maxMembers;
  if (max == null || max <= 0) return plan.slug === 'enterprise' ? { kind: 'custom' } : { kind: 'unlimited' };
  if (max === 1) return { kind: 'exact', count: 1 };
  return { kind: 'upTo', count: max };
}

export interface PlanCardCopy {
  seatsOne: string;
  seatsUpTo: string;
  seatsUnlimited: string;
  seatsCustom: string;
  allAppsIncluded: string;
}

/** The seat line on a plan card, e.g. "1 user" or "Up to 10 users". */
export function planSeatLine(plan: Pick<Billing.BillingPlan, 'slug' | 'maxMembers'>, copy: PlanCardCopy): string {
  const limit = planSeatLimit(plan);
  switch (limit.kind) {
    case 'exact':
      return copy.seatsOne;
    case 'upTo':
      return fillTemplate(copy.seatsUpTo, { count: limit.count });
    case 'unlimited':
      return copy.seatsUnlimited;
    case 'custom':
      return copy.seatsCustom;
  }
}

/**
 * The feature lines of a plan card: the derived seat line first, then (Free
 * only, the others say it in their description) what the plan includes of the
 * apps, then the curated list.
 */
export function planCardFeatures(
  plan: Pick<Billing.BillingPlan, 'slug' | 'name' | 'maxMembers'>,
  copy: PlanCardCopy,
): string[] {
  const lines = [planSeatLine(plan, copy)];
  if (resolvePlanKey(plan, PLAN_FEATURES) === 'free') lines.push(copy.allAppsIncluded);
  return [...lines, ...formatPlanFeatures(plan)];
}

/** The seat cell of the comparison table: "1", "Up to 10", "Unlimited" or "Custom". */
export function planSeatCell(
  plan: Pick<Billing.BillingPlan, 'slug' | 'maxMembers'>,
  copy: { seatsOne: string; seatsUpTo: string; unlimited: string; custom: string },
): string {
  const limit = planSeatLimit(plan);
  switch (limit.kind) {
    case 'exact':
      return copy.seatsOne;
    case 'upTo':
      return fillTemplate(copy.seatsUpTo, { count: limit.count });
    case 'unlimited':
      return copy.unlimited;
    case 'custom':
      return copy.custom;
  }
}

type PlanPrices = Pick<Billing.BillingPlan, 'monthlyPrice' | 'yearlyPrice' | 'priceOnRequest'>;

/**
 * Per seat per year, in cents. A plan without a yearly price is twelve months
 * at the monthly price (no annual saving), the same rule app-api applies.
 */
export const yearlyPriceOf = (plan: Pick<Billing.BillingPlan, 'monthlyPrice' | 'yearlyPrice'>): number =>
  plan.yearlyPrice || plan.monthlyPrice * 12;

/** Whole-percent saving of annual over monthly billing, 0 when there is none. */
export function annualSavingPercent(plan: PlanPrices): number {
  if (plan.priceOnRequest || !plan.monthlyPrice) return 0;
  return Math.max(0, Math.round((1 - yearlyPriceOf(plan) / (plan.monthlyPrice * 12)) * 100));
}

/**
 * The saving the billing-cycle toggle advertises: the largest per-plan saving,
 * worded "up to" when the plans differ. `percent` 0 means nothing to advertise.
 */
export function annualSavingSummary(plans: PlanPrices[]): { percent: number; isRange: boolean } {
  const savings = plans.map(annualSavingPercent).filter((percent) => percent > 0);
  if (savings.length === 0) return { percent: 0, isRange: false };
  const max = Math.max(...savings);
  return { percent: max, isRange: savings.some((percent) => percent !== max) };
}
