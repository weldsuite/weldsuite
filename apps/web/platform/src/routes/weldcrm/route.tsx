import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldcrm/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm')({
  staticData: { breadcrumb: { label: 'CRM' } },
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
