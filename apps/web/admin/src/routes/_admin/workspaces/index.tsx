import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getWorkspacesPage } from '@/app/workspaces/fn';
import { WorkspacesPage } from '@/app/workspaces/view';

const searchSchema = z.object({
  search: z.coerce.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_admin/workspaces/')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getWorkspacesPage({ data: deps }),
  component: WorkspacesRoute,
});

function WorkspacesRoute() {
  return <WorkspacesPage {...Route.useLoaderData()} />;
}
