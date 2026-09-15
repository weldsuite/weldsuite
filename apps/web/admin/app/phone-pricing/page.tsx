import { requireAdmin } from '@/lib/auth';
import { listPhonePricing } from '@/lib/phone-pricing-data';
import { PhonePricingList } from './phone-pricing-list';

export const dynamic = 'force-dynamic';

export default async function PhonePricingPage() {
  await requireAdmin();
  const { rows, defaultMarkup } = await listPhonePricing();
  const stats = {
    total: rows.length,
    active: rows.filter((r) => r.isActive).length,
  };
  return <PhonePricingList rows={rows} stats={stats} defaultMarkup={defaultMarkup} />;
}
