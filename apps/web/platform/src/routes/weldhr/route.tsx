import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldhr/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr')({
  staticData: { breadcrumb: { label: 'WeldHR' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
