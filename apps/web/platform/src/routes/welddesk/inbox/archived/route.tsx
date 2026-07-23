import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/inbox/archived/layout';

export const Route = createFileRoute('/welddesk/inbox/archived')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
