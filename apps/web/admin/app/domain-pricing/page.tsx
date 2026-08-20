import { requireAdmin } from '@/lib/auth';
import { listDomainPricing } from '@/lib/domain-pricing-data';
import { DomainPricingList } from './domain-pricing-list';

export const dynamic = 'force-dynamic';

export default async function DomainPricingPage() {
  await requireAdmin();
  const rows = await listDomainPricing();
  const stats = {
    total: rows.length,
    active: rows.filter((r) => r.isActive).length,
    popular: rows.filter((r) => r.isPopular).length,
  };
  return <DomainPricingList rows={rows} stats={stats} />;
}
