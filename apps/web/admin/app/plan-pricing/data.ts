import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { getPlanCountryPricing } from '@/lib/plan-pricing-data';

/** Everything the plan pricing page shows. */
export async function loadPlanPricingPage() {
  const admin = await requireAdmin();
  const pricing = await getPlanCountryPricing();
  return { pricing, canEdit: admin.role !== 'viewer' };
}

export type PlanPricingPageData = NonNullable<Awaited<ReturnType<typeof loadPlanPricingPage>>>;
