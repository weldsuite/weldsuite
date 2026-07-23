import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/inbox/chat/layout';

export const Route = createFileRoute('/welddesk/inbox/chat')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
