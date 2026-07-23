import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/project/[projectId]/layout';

export const Route = createFileRoute('/weldflow/project/$projectId')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
