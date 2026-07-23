import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/inbox/all/layout';

export const Route = createFileRoute('/welddesk/inbox/all')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
