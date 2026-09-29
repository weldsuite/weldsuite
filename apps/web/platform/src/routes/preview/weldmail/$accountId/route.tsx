import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/[accountId]/layout';

export const Route = createFileRoute('/preview/weldmail/$accountId')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
