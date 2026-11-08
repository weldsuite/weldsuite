import { createFileRoute } from '@tanstack/react-router';
import { getPlansPage } from '@/app/plans/fn';
import { PlansPage } from '@/app/plans/view';

export const Route = createFileRoute('/_admin/plans/')({
  loader: () => getPlansPage(),
  component: PlansRoute,
});

function PlansRoute() {
  return <PlansPage {...Route.useLoaderData()} />;
}
