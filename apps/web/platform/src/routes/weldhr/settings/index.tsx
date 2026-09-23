import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/settings/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/settings/')({
  staticData: { breadcrumb: { label: 'Settings' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
