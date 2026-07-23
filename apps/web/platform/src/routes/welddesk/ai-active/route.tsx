import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/ai-active/layout';

export const Route = createFileRoute('/welddesk/ai-active')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
