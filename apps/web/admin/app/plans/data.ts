import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { GLOBAL } from '@/lib/edition';
import { listPlanDetails } from '@/lib/billing-data';

/** Everything the plan catalog list shows. */
export async function loadPlansPage() {
  const identity = await requireAdmin();
  const plans = await listPlanDetails();

  return {
    plans,
    // Plans change through the billing worker (Stripe), which only Global has.
    canWrite: GLOBAL && identity.role !== 'viewer',
  };
}

export type PlansPageData = NonNullable<Awaited<ReturnType<typeof loadPlansPage>>>;
