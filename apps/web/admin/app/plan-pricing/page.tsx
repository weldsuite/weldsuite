import { loadPlanPricingPage } from './data';
import { PlanPricingPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadPlanPricingPage();
  return <PlanPricingPage {...data} />;
}
