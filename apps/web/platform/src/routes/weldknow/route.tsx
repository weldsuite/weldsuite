import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldknow/layout';

export const Route = createFileRoute('/weldknow')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
