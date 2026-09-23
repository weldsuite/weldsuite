import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/portal/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/portal/')({
  staticData: { breadcrumb: { label: 'Workforce portal' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
