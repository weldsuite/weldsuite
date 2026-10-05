import type { Billing } from '@/lib/api/types/apps/billing.types';

// Curated feature lists per plan, keyed by plan slug
export const PLAN_FEATURES: Record<string, string[]> = {
  free: [
    'Up to 2 users',
    '100 credits included',
    '1,000 emails per month',
    'All apps included',
    'Unlimited contacts',
    'Two-factor authentication',
  ],
  business: [
    'Up to 25 users (3 user minimum)',
    '250 GB storage per user',
    'API access & webhooks',
    'Custom email domains',
    'Roles & permissions',
    'Standard support',
  ],
  scale: [
    'Unlimited users',
    '1 TB storage per user',
    'Priority support',
    'Advanced roles & permissions',
    '90-day automation history',
    'Call & meeting intelligence',
  ],
  enterprise: [
    'Custom seat limit',
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
