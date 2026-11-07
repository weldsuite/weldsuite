import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { listPhonePricing } from '@/lib/phone-pricing-data';

/** Everything the phone pricing page shows. */
export async function loadPhonePricingPage() {
  await requireAdmin();
  const { rows, defaultMarkup } = await listPhonePricing();
  const stats = {
    total: rows.length,
    active: rows.filter((r) => r.isActive).length,
  };
  return { rows, stats, defaultMarkup };
}

export type PhonePricingPageData = NonNullable<Awaited<ReturnType<typeof loadPhonePricingPage>>>;
