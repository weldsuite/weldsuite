import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/lib/breadcrumbs/types';
import LayoutComponent from '@/app/weldsign/layout';

export const Route = createFileRoute('/weldsign')({
  staticData: { breadcrumb: { label: 'WeldSign' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
