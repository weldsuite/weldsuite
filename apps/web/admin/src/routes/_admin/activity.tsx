import { createFileRoute } from '@tanstack/react-router';
import { getActivityPage } from '@/app/activity/fn';
import { ActivityPage } from '@/app/activity/view';

export const Route = createFileRoute('/_admin/activity')({
  loader: () => getActivityPage(),
  component: ActivityRoute,
});

function ActivityRoute() {
  return <ActivityPage {...Route.useLoaderData()} />;
}
