import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/settings/apps/welddesk/layout';

export const Route = createFileRoute('/settings/apps/welddesk')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
