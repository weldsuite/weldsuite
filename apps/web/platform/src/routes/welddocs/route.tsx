import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/lib/breadcrumbs/types';
import LayoutComponent from '@/app/welddocs/layout';

export const Route = createFileRoute('/welddocs')({
  staticData: { breadcrumb: { label: 'WeldDocs' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
