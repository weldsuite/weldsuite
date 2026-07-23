import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldcall/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcall')({
  staticData: { breadcrumb: { label: 'WeldCall' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
