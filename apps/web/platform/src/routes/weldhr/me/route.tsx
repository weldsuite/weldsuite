import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldhr/me/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me')({
  staticData: { breadcrumb: { label: 'My HR' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
