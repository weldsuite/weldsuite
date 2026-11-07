import { createFileRoute } from '@tanstack/react-router';
import { getNewPartnerPage } from '@/app/partners/new/fn';
import { NewPartnerPage } from '@/app/partners/new/view';

export const Route = createFileRoute('/_admin/partners/new')({
  loader: () => getNewPartnerPage(),
  component: NewPartnerRoute,
});

function NewPartnerRoute() {
  return <NewPartnerPage {...Route.useLoaderData()} />;
}
