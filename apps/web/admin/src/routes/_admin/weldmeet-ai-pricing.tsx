import { createFileRoute } from '@tanstack/react-router';
import { getWeldmeetAiPricingPage } from '@/app/weldmeet-ai-pricing/fn';
import { WeldmeetAiPricingPage } from '@/app/weldmeet-ai-pricing/view';

export const Route = createFileRoute('/_admin/weldmeet-ai-pricing')({
  loader: () => getWeldmeetAiPricingPage(),
  component: WeldmeetAiPricingRoute,
});

function WeldmeetAiPricingRoute() {
  return <WeldmeetAiPricingPage {...Route.useLoaderData()} />;
}
