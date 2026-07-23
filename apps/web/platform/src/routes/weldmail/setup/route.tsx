import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/setup/layout';

export const Route = createFileRoute('/weldmail/setup')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
