import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/lib/breadcrumbs/types';
import LayoutComponent from '@/app/weldsheets/layout';

export const Route = createFileRoute('/weldsheets')({
  staticData: { breadcrumb: { label: 'WeldSheets' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
