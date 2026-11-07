import { createFileRoute } from '@tanstack/react-router';
import { getNewPlanPage } from '@/app/plans/new/fn';
import { NewPlanPage } from '@/app/plans/new/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/plans/new')({
  beforeLoad: globalOnlyRoute,
  loader: () => getNewPlanPage(),
  component: NewPlanRoute,
});

function NewPlanRoute() {
  return <NewPlanPage {...Route.useLoaderData()} />;
}
