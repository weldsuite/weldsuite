import { createFileRoute } from '@tanstack/react-router';
import { getPlanPricingPage } from '@/app/plan-pricing/fn';
import { PlanPricingPage } from '@/app/plan-pricing/view';

export const Route = createFileRoute('/_admin/plan-pricing')({
  loader: () => getPlanPricingPage(),
  component: PlanPricingRoute,
});

function PlanPricingRoute() {
  return <PlanPricingPage {...Route.useLoaderData()} />;
}
