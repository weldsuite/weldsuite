import { createFileRoute } from '@tanstack/react-router';
import { getPartnersPage } from '@/app/partners/fn';
import { PartnersPage } from '@/app/partners/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/partners/')({
  beforeLoad: globalOnlyRoute,
  loader: () => getPartnersPage(),
  component: PartnersRoute,
});

function PartnersRoute() {
  return <PartnersPage {...Route.useLoaderData()} />;
}
