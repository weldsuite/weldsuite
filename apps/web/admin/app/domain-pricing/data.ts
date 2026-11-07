import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { listDomainPricing } from '@/lib/domain-pricing-data';

/** Everything the domain pricing page shows. */
export async function loadDomainPricingPage() {
  await requireAdmin();
  const rows = await listDomainPricing();
  const stats = {
    total: rows.length,
    active: rows.filter((r) => r.isActive).length,
    popular: rows.filter((r) => r.isPopular).length,
  };
  return { rows, stats };
}

export type DomainPricingPageData = NonNullable<Awaited<ReturnType<typeof loadDomainPricingPage>>>;
