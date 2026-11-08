import { createFileRoute } from '@tanstack/react-router';
import { getWorkspaceDetailPage } from '@/app/workspaces/[id]/fn';
import { WorkspaceDetailPage } from '@/app/workspaces/[id]/view';

export const Route = createFileRoute('/_admin/workspaces/$id')({
  loader: ({ params }) => getWorkspaceDetailPage({ data: { id: params.id } }),
  component: WorkspaceDetailRoute,
});

function WorkspaceDetailRoute() {
  return <WorkspaceDetailPage {...Route.useLoaderData()} />;
}
