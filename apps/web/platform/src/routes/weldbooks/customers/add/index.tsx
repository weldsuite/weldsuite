import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/customers/add/page';

export const Route = createFileRoute('/weldbooks/customers/add/')({
  // `?role=supplier` opens the same screen for a new supplier.
  validateSearch: (search: Record<string, unknown>): { role?: 'supplier' } =>
    search.role === 'supplier' ? { role: 'supplier' } : {},
  component: PageComponent,
});
