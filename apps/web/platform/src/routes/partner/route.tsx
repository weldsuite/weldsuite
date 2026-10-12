import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/partner/layout';

export const Route = createFileRoute('/partner')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
