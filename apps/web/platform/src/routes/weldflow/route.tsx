import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/layout';

export const Route = createFileRoute('/weldflow')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
