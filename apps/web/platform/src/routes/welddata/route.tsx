import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddata/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/welddata')({
  staticData: { breadcrumb: { label: 'WeldData' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
