import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/project/[projectId]/sprints/[sprintId]/layout';

export const Route = createFileRoute('/weldflow/project/$projectId/sprints/$sprintId')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
