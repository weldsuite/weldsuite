import { createFileRoute } from '@tanstack/react-router';
import { getEditAppPage } from '@/app/apps/[id]/fn';
import { EditAppPage } from '@/app/apps/[id]/view';

export const Route = createFileRoute('/_admin/apps/$id')({
  loader: ({ params }) => getEditAppPage({ data: { id: params.id } }),
  component: EditAppRoute,
});

function EditAppRoute() {
  return <EditAppPage {...Route.useLoaderData()} />;
}
