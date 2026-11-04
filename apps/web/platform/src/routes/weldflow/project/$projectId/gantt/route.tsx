import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/project/[projectId]/gantt/layout';

export const Route = createFileRoute('/weldflow/project/$projectId/gantt')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
