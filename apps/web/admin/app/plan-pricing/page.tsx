import { requireAdmin } from '@/lib/auth';
import { getPlanCountryPricing } from '@/lib/plan-pricing-data';
import { PlanPricingList } from './plan-pricing-list';

export const dynamic = 'force-dynamic';

export default async function PlanPricingPage() {
  const admin = await requireAdmin();
  const pricing = await getPlanCountryPricing();
  return <PlanPricingList pricing={pricing} canEdit={admin.role !== 'viewer'} />;
}
