import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldchat/layout';

export const Route = createFileRoute('/weldchat')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
