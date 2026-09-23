import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/lifecycle/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/lifecycle/')({
  staticData: { breadcrumb: { label: 'On- & offboarding' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
