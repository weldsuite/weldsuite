import { createFileRoute } from '@tanstack/react-router';
import { getDatabasesPage } from '@/app/databases/fn';
import { DatabasesPage } from '@/app/databases/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/databases/')({
  beforeLoad: globalOnlyRoute,
  loader: () => getDatabasesPage(),
  component: DatabasesRoute,
});

function DatabasesRoute() {
  return <DatabasesPage {...Route.useLoaderData()} />;
}
