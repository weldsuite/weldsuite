import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/settings/layout';

export const Route = createFileRoute('/settings')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
