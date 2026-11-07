import { createFileRoute } from '@tanstack/react-router';
import { getDomainPricingPage } from '@/app/domain-pricing/fn';
import { DomainPricingPage } from '@/app/domain-pricing/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/domain-pricing')({
  beforeLoad: globalOnlyRoute,
  loader: () => getDomainPricingPage(),
  component: DomainPricingRoute,
});

function DomainPricingRoute() {
  return <DomainPricingPage {...Route.useLoaderData()} />;
}
