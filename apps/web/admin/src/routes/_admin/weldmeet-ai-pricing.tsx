import { createFileRoute } from '@tanstack/react-router';
import { getWeldmeetAiPricingPage } from '@/app/weldmeet-ai-pricing/fn';
import { WeldmeetAiPricingPage } from '@/app/weldmeet-ai-pricing/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/weldmeet-ai-pricing')({
  beforeLoad: globalOnlyRoute,
  loader: () => getWeldmeetAiPricingPage(),
  component: WeldmeetAiPricingRoute,
});

function WeldmeetAiPricingRoute() {
  return <WeldmeetAiPricingPage {...Route.useLoaderData()} />;
}
