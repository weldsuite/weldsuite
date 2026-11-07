import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { listPlanOptions } from '@/lib/billing-data';
import { getPartnerContractDefaults } from '@/lib/partner-contract-defaults-data';

/** Everything the partner contract defaults page shows. */
export async function loadPartnerContractDefaultsPage() {
  const identity = await requireAdmin();
  const [plans, defaults] = await Promise.all([listPlanOptions(), getPartnerContractDefaults()]);

  return {
    planOptions: plans,
    defaults,
    canWrite: identity.role !== 'viewer',
  };
}

export type PartnerContractDefaultsPageData = NonNullable<
  Awaited<ReturnType<typeof loadPartnerContractDefaultsPage>>
>;
