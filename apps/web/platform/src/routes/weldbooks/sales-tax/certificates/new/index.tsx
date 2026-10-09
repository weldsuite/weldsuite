import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/certificates/new/page';

export const Route = createFileRoute('/weldbooks/sales-tax/certificates/new/')({
  // `?partyId=` pre-selects the customer (the customer page's Exemptions tab links here).
  validateSearch: (search: Record<string, unknown>): { partyId?: string } => ({
    partyId: typeof search.partyId === 'string' && search.partyId ? search.partyId : undefined,
  }),
  component: PageComponent,
});
