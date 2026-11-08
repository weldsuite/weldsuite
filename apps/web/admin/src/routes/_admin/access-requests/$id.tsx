import { createFileRoute } from '@tanstack/react-router';
import { getAccessRequestPage } from '@/app/access-requests/[id]/fn';
import { AccessRequestPage } from '@/app/access-requests/[id]/view';

export const Route = createFileRoute('/_admin/access-requests/$id')({
  loader: ({ params }) => getAccessRequestPage({ data: { id: params.id } }),
  component: AccessRequestRoute,
});

function AccessRequestRoute() {
  return <AccessRequestPage {...Route.useLoaderData()} />;
}
