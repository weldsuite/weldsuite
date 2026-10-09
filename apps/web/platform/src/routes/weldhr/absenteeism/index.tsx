import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/absenteeism/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/absenteeism/')({
  staticData: { breadcrumb: { label: 'Absenteeism' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
