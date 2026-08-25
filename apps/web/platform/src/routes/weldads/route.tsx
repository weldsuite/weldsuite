import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldads/layout';

export const Route = createFileRoute('/weldads')({
  staticData: { breadcrumb: { label: 'WeldAds' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
