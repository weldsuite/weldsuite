import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldstash/layout';

export const Route = createFileRoute('/weldstash')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
