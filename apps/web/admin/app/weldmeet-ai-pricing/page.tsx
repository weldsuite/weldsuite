import { requireAdmin } from '@/lib/auth';
import { getWeldmeetAiPricing } from '@/lib/weldmeet-ai-pricing-data';
import { WeldmeetAiPricingForm } from './weldmeet-ai-pricing-form';

export const dynamic = 'force-dynamic';

export default async function WeldmeetAiPricingPage() {
  await requireAdmin();
  const pricing = await getWeldmeetAiPricing();
  return <WeldmeetAiPricingForm pricing={pricing} />;
}
