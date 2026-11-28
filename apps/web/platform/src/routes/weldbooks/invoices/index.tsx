import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/invoices/page';

/** A search value as text; the router parses numeric-looking values, and a list filter is never a number. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

export const Route = createFileRoute('/weldbooks/invoices/')({
  // The list's filters live in the address: `?status=overdue` (an invoice status), `?show=open|overdue|credit_notes`.
  // Every other parameter (`?stack=` of the object panel) passes through; the page ignores values it does not offer.
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> & { status?: string; show?: string } => ({
    ...search,
    status: text(search.status),
    show: text(search.show),
  }),
  component: PageComponent,
});
