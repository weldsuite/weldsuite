import { createFileRoute } from '@tanstack/react-router';
import { getPhonePricingPage } from '@/app/phone-pricing/fn';
import { PhonePricingPage } from '@/app/phone-pricing/view';

export const Route = createFileRoute('/_admin/phone-pricing')({
  loader: () => getPhonePricingPage(),
  component: PhonePricingRoute,
});

function PhonePricingRoute() {
  return <PhonePricingPage {...Route.useLoaderData()} />;
}
