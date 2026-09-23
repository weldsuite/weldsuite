import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/clients/[companyId]/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/clients/$companyId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
