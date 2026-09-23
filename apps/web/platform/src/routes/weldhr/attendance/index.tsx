import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/attendance/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/attendance/')({
  staticData: { breadcrumb: { label: 'Attendance' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
