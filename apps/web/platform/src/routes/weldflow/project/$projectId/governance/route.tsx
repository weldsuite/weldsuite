import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/project/[projectId]/governance/layout';

export const Route = createFileRoute('/weldflow/project/$projectId/governance')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
