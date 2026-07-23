import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddrive/layout';

export const Route = createFileRoute('/welddrive')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
