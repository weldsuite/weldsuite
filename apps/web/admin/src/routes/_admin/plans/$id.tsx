import { createFileRoute } from '@tanstack/react-router';
import { getPlanDetailPage } from '@/app/plans/[id]/fn';
import { PlanDetailPage } from '@/app/plans/[id]/view';

export const Route = createFileRoute('/_admin/plans/$id')({
  loader: ({ params }) => getPlanDetailPage({ data: { id: params.id } }),
  component: PlanDetailRoute,
});

function PlanDetailRoute() {
  return <PlanDetailPage {...Route.useLoaderData()} />;
}
