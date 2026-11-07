import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { getWeldmeetAiPricing } from '@/lib/weldmeet-ai-pricing-data';

/** Everything the WeldMeet AI pricing page shows. */
export async function loadWeldmeetAiPricingPage() {
  await requireAdmin();
  const pricing = await getWeldmeetAiPricing();
  return { pricing };
}

export type WeldmeetAiPricingPageData = NonNullable<Awaited<ReturnType<typeof loadWeldmeetAiPricingPage>>>;
