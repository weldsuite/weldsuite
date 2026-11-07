import { createFileRoute } from '@tanstack/react-router';
import { getDatabasesPage } from '@/app/databases/fn';
import { DatabasesPage } from '@/app/databases/view';

export const Route = createFileRoute('/_admin/databases/')({
  loader: () => getDatabasesPage(),
  component: DatabasesRoute,
});

function DatabasesRoute() {
  return <DatabasesPage {...Route.useLoaderData()} />;
}
