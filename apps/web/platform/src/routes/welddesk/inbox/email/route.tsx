import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/inbox/email/layout';

export const Route = createFileRoute('/welddesk/inbox/email')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
