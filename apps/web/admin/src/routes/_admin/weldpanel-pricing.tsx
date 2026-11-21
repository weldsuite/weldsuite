import { createFileRoute } from '@tanstack/react-router';
import { getWeldpanelPricingPage } from '@/app/weldpanel-pricing/fn';
import { WeldpanelPricingPage } from '@/app/weldpanel-pricing/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/weldpanel-pricing')({
  beforeLoad: globalOnlyRoute,
  loader: () => getWeldpanelPricingPage(),
  component: WeldpanelPricingRoute,
});

function WeldpanelPricingRoute() {
  return <WeldpanelPricingPage {...Route.useLoaderData()} />;
}
