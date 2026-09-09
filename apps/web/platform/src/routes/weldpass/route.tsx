import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldpass/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpass')({
  staticData: { breadcrumb: { label: 'WeldPass' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
