import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/appstore/layout';

export const Route = createFileRoute('/appstore')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
