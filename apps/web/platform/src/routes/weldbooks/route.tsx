import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldbooks/layout';

export const Route = createFileRoute('/weldbooks')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
