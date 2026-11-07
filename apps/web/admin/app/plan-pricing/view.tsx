import { PlanPricingList } from './plan-pricing-list';
import type { PlanPricingPageData } from './data';

export function PlanPricingPage({ pricing, canEdit }: Readonly<PlanPricingPageData>) {
  return <PlanPricingList pricing={pricing} canEdit={canEdit} />;
}
