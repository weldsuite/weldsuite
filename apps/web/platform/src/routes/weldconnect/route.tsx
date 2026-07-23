import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldconnect/layout';

export const Route = createFileRoute('/weldconnect')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
