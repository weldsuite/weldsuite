import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/leave/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/leave/')({
  staticData: { breadcrumb: { label: 'Leave' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
