import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { getWeldpanelPricing } from '@/lib/weldpanel-pricing-data';

/** Everything the WeldPanel pricing page shows. */
export async function loadWeldpanelPricingPage() {
  await requireAdmin();
  const pricing = await getWeldpanelPricing();
  return { pricing };
}

export type WeldpanelPricingPageData = NonNullable<Awaited<ReturnType<typeof loadWeldpanelPricingPage>>>;
