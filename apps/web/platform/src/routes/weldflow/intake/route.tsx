import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/intake/layout';

export const Route = createFileRoute('/weldflow/intake')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
