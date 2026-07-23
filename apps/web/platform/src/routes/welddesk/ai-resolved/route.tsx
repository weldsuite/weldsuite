import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/ai-resolved/layout';

export const Route = createFileRoute('/welddesk/ai-resolved')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
