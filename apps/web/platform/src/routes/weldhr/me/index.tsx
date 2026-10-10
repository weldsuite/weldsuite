import { createFileRoute, redirect } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/page';
import { LEGACY_MY_HR_TABS, MY_HR_PATHS } from '@/app/weldhr/access';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/')({
  staticData: { breadcrumb: { label: 'Overview' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  // My HR used to be one page with `?tab=`; each tab is its own page now.
  beforeLoad: ({ search }) => {
    if (search.tab === undefined) return;
    throw redirect({ to: LEGACY_MY_HR_TABS[search.tab] ?? MY_HR_PATHS.overview, replace: true });
  },
  component: PageComponent,
});
