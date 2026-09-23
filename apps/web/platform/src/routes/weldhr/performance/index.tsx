import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/performance/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/performance/')({
  staticData: { breadcrumb: { label: 'KPIs & milestones' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
