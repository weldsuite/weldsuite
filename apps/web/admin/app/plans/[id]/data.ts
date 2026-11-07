import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { GLOBAL } from '@/lib/edition';
import { getPlanDetail, listAuditEvents } from '@/lib/billing-data';

/** Everything the plan detail page shows; null when there is no such plan. */
export async function loadPlanDetailPage(input: { id: string }) {
  const identity = await requireAdmin();
  const plan = await getPlanDetail(input.id);
  if (!plan) return null;
  const history = await listAuditEvents({ plan: plan.id, limit: 50 });

  return {
    plan,
    history,
    // Plans change through the billing worker (Stripe), which only Global has.
    canWrite: GLOBAL && identity.role !== 'viewer',
  };
}

export type PlanDetailPageData = NonNullable<Awaited<ReturnType<typeof loadPlanDetailPage>>>;
