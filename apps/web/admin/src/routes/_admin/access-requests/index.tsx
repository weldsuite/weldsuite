import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getAccessRequestsPage } from '@/app/access-requests/fn';
import { AccessRequestsPage } from '@/app/access-requests/view';

const searchSchema = z.object({
  status: z.coerce.string().optional().catch(undefined),
  q: z.coerce.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_admin/access-requests/')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAccessRequestsPage({ data: deps }),
  component: AccessRequestsRoute,
});

function AccessRequestsRoute() {
  return <AccessRequestsPage {...Route.useLoaderData()} />;
}
