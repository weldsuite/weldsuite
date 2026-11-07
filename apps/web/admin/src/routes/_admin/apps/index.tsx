import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getAppsPage } from '@/app/apps/fn';
import { AppsPage } from '@/app/apps/view';

const searchSchema = z.object({
  search: z.coerce.string().optional().catch(undefined),
  category: z.coerce.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_admin/apps/')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAppsPage({ data: deps }),
  component: AppsRoute,
});

function AppsRoute() {
  return <AppsPage {...Route.useLoaderData()} />;
}
