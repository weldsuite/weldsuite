import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmeet/layout';

export const Route = createFileRoute('/weldmeet')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
