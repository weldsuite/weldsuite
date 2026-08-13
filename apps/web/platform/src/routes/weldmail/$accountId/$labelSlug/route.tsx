import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/[accountId]/[labelSlug]/layout';
import { parseMailSearch } from '@/app/weldmail/lib/mail-urls';

export const Route = createFileRoute('/weldmail/$accountId/$labelSlug')({
  validateSearch: parseMailSearch,
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
