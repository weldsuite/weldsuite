import { createFileRoute } from '@tanstack/react-router';
import { getPartnersPage } from '@/app/partners/fn';
import { PartnersPage } from '@/app/partners/view';

export const Route = createFileRoute('/_admin/partners/')({
  loader: () => getPartnersPage(),
  component: PartnersRoute,
});

function PartnersRoute() {
  return <PartnersPage {...Route.useLoaderData()} />;
}
