import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/agencies/new/page';

export const Route = createFileRoute('/weldbooks/sales-tax/agencies/new/')({
  // `?state=TX` pre-fills the state (the nexus monitor and the provider registration check link here).
  validateSearch: (search: Record<string, unknown>): { state?: string } => ({
    state: typeof search.state === 'string' && search.state ? search.state : undefined,
  }),
  component: PageComponent,
});
