import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/quotes/page';

/** A search value as text; the router parses numeric-looking values, and a list filter is never a number. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

export const Route = createFileRoute('/weldbooks/quotes/')({
  // The status filter lives in the address: `?status=sent`. Every other parameter (`?stack=` of the object panel)
  // passes through; the page ignores a status it does not offer.
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> & { status?: string } => ({
    ...search,
    status: text(search.status),
  }),
  component: PageComponent,
});
