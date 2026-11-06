import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/lib/breadcrumbs/types';
import LayoutComponent from '@/app/weldmerge/layout';

export const Route = createFileRoute('/weldmerge')({
  staticData: { breadcrumb: { label: 'WeldMerge' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
