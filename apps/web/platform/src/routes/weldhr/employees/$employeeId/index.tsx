import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/employees/[employeeId]/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/employees/$employeeId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
