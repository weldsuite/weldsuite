import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/inbox/slack/layout';

export const Route = createFileRoute('/welddesk/inbox/slack')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
