import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/inbox/discord/layout';

export const Route = createFileRoute('/welddesk/inbox/discord')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
