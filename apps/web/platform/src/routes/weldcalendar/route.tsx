import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldcalendar/layout';

export const Route = createFileRoute('/weldcalendar')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
