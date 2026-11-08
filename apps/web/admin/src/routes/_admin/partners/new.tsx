import { createFileRoute } from '@tanstack/react-router';
import { getNewPartnerPage } from '@/app/partners/new/fn';
import { NewPartnerPage } from '@/app/partners/new/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/partners/new')({
  beforeLoad: globalOnlyRoute,
  loader: () => getNewPartnerPage(),
  component: NewPartnerRoute,
});

function NewPartnerRoute() {
  return <NewPartnerPage {...Route.useLoaderData()} />;
}
