import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/')({
  staticData: { breadcrumb: { label: 'My HR' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
