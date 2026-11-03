import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/project/[projectId]/scope/layout';

export const Route = createFileRoute('/weldflow/project/$projectId/scope')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
