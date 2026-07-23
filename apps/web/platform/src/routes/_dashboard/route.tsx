import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/(dashboard)/layout';

export const Route = createFileRoute('/_dashboard')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
