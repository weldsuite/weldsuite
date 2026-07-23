import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldhost/layout';

export const Route = createFileRoute('/weldhost')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
