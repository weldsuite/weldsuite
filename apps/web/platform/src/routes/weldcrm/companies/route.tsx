import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldcrm/companies/layout';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm/companies')({
  staticData: { breadcrumb: { label: 'Companies' } },
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
