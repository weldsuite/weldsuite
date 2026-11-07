import { createFileRoute } from '@tanstack/react-router';
import { getPartnerContractDefaultsPage } from '@/app/partners/defaults/fn';
import { PartnerContractDefaultsPage } from '@/app/partners/defaults/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/partners/defaults')({
  beforeLoad: globalOnlyRoute,
  loader: () => getPartnerContractDefaultsPage(),
  component: PartnerContractDefaultsRoute,
});

function PartnerContractDefaultsRoute() {
  return <PartnerContractDefaultsPage {...Route.useLoaderData()} />;
}
