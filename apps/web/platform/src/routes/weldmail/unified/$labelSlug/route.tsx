import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/unified/[labelSlug]/layout';
import { parseMailSearch } from '@/app/weldmail/lib/mail-urls';

export const Route = createFileRoute('/weldmail/unified/$labelSlug')({
  validateSearch: parseMailSearch,
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
