import { createFileRoute } from '@tanstack/react-router';
import { getNewAppPage } from '@/app/apps/new/fn';
import { NewAppPage } from '@/app/apps/new/view';

export const Route = createFileRoute('/_admin/apps/new')({
  loader: () => getNewAppPage(),
  component: NewAppRoute,
});

function NewAppRoute() {
  return <NewAppPage {...Route.useLoaderData()} />;
}
