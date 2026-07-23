import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/[accountId]/[labelSlug]/layout';

export const Route = createFileRoute('/weldmail/$accountId/$labelSlug')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
