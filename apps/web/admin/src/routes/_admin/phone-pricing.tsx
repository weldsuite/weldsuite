import { createFileRoute } from '@tanstack/react-router';
import { getPhonePricingPage } from '@/app/phone-pricing/fn';
import { PhonePricingPage } from '@/app/phone-pricing/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/phone-pricing')({
  beforeLoad: globalOnlyRoute,
  loader: () => getPhonePricingPage(),
  component: PhonePricingRoute,
});

function PhonePricingRoute() {
  return <PhonePricingPage {...Route.useLoaderData()} />;
}
