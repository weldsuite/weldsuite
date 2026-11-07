import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { listPlanDetails } from '@/lib/billing-data';

/** Everything the plan catalog list shows. */
export async function loadPlansPage() {
  const identity = await requireAdmin();
  const plans = await listPlanDetails();

  return {
    plans,
    canWrite: identity.role !== 'viewer',
  };
}

export type PlansPageData = NonNullable<Awaited<ReturnType<typeof loadPlansPage>>>;
