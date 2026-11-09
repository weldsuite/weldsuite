import { createFileRoute } from '@tanstack/react-router';
import { getStaffPage } from '@/app/staff/fn';
import { StaffPage } from '@/app/staff/view';
import { kubernetesOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/staff')({
  beforeLoad: kubernetesOnlyRoute,
  loader: () => getStaffPage(),
  component: StaffRoute,
});

function StaffRoute() {
  return <StaffPage {...Route.useLoaderData()} />;
}
