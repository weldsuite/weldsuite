import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldreach/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldreach')({
  staticData: { breadcrumb: { label: 'WeldReach' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
