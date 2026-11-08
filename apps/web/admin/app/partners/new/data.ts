import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { listPlanOptions } from '@/lib/billing-data';
import { getPartnerContractDefaults } from '@/lib/partner-contract-defaults-data';

/**
 * Everything the new partner form needs. Viewers get `canWrite: false` and no
 * data: the page sends them back to the partner list.
 */
export async function loadNewPartnerPage() {
  const identity = await requireAdmin();
  if (identity.role === 'viewer') return { canWrite: false as const };
  const [plans, defaults] = await Promise.all([listPlanOptions(), getPartnerContractDefaults()]);

  return {
    canWrite: true as const,
    planOptions: plans,
    contractDefaults: defaults.terms,
  };
}

export type NewPartnerPageData = NonNullable<Awaited<ReturnType<typeof loadNewPartnerPage>>>;
