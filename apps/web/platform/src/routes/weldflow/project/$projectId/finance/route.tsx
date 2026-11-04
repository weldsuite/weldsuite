import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldflow/project/[projectId]/finance/layout';

export const Route = createFileRoute('/weldflow/project/$projectId/finance')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
