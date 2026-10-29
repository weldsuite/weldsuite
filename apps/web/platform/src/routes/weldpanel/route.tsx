import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/lib/breadcrumbs/types';
import LayoutComponent from '@/app/weldpanel/layout';

export const Route = createFileRoute('/weldpanel')({
  staticData: { breadcrumb: { label: 'WeldPanel' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
