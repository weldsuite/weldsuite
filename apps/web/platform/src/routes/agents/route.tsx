import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/agents/layout';

export const Route = createFileRoute('/agents')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
});
