import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/lib/breadcrumbs/types';
import LayoutComponent from '@/app/weldforms/layout';

export const Route = createFileRoute('/weldforms')({
  staticData: { breadcrumb: { label: 'WeldForms' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
