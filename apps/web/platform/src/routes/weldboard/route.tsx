import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/lib/breadcrumbs/types';
import LayoutComponent from '@/app/weldboard/layout';

export const Route = createFileRoute('/weldboard')({
  staticData: { breadcrumb: { label: 'WeldBoard' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
