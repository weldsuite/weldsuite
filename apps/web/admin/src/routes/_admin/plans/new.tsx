import { createFileRoute } from '@tanstack/react-router';
import { getNewPlanPage } from '@/app/plans/new/fn';
import { NewPlanPage } from '@/app/plans/new/view';

export const Route = createFileRoute('/_admin/plans/new')({
  loader: () => getNewPlanPage(),
  component: NewPlanRoute,
});

function NewPlanRoute() {
  return <NewPlanPage {...Route.useLoaderData()} />;
}
