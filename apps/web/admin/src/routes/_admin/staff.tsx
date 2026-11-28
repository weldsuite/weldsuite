import { createFileRoute } from '@tanstack/react-router';
import { getStaffPage } from '@/app/staff/fn';
import { StaffPage } from '@/app/staff/view';

export const Route = createFileRoute('/_admin/staff')({
  loader: () => getStaffPage(),
  component: StaffRoute,
});

function StaffRoute() {
  return <StaffPage {...Route.useLoaderData()} />;
}
