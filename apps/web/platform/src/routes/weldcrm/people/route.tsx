import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldcrm/people/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm/people')({
  staticData: { breadcrumb: { label: 'People' } },
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
