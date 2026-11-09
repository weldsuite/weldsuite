import { createFileRoute } from '@tanstack/react-router';
import { getDashboardPage } from '@/app/dashboard-fn';
import { DashboardPage } from '@/app/dashboard-view';

export const Route = createFileRoute('/_admin/')({
  loader: () => getDashboardPage(),
  component: DashboardRoute,
});

function DashboardRoute() {
  return <DashboardPage {...Route.useLoaderData()} />;
}
