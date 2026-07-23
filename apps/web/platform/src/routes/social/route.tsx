import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/social/layout';

export const Route = createFileRoute('/social')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
