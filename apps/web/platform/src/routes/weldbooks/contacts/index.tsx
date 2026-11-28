import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/contacts/page';

export const Route = createFileRoute('/weldbooks/contacts/')({
  // `role` is the list's own filter; every other parameter (`?stack=` of the object panel) passes through.
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> & { role?: 'customer' | 'supplier' } => ({
    ...search,
    role: search.role === 'customer' || search.role === 'supplier' ? search.role : undefined,
  }),
  component: PageComponent,
});
