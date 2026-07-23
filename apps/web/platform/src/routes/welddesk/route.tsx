import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/layout';

export const Route = createFileRoute('/welddesk')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
