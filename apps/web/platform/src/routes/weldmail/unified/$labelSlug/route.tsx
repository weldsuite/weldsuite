import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/unified/[labelSlug]/layout';

export const Route = createFileRoute('/weldmail/unified/$labelSlug')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
