import { createFileRoute } from '@tanstack/react-router';
import { getPartnerContractDefaultsPage } from '@/app/partners/defaults/fn';
import { PartnerContractDefaultsPage } from '@/app/partners/defaults/view';

export const Route = createFileRoute('/_admin/partners/defaults')({
  loader: () => getPartnerContractDefaultsPage(),
  component: PartnerContractDefaultsRoute,
});

function PartnerContractDefaultsRoute() {
  return <PartnerContractDefaultsPage {...Route.useLoaderData()} />;
}
