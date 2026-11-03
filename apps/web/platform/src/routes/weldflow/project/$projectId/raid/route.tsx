import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/project/[projectId]/raid/layout';

export const Route = createFileRoute('/weldflow/project/$projectId/raid')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
