import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/questions/page';

/** A search value as text; the router parses numeric-looking values, and a filter is never a number. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

export const Route = createFileRoute('/weldbooks/questions/')({
  // The list's filters live in the address: `?status=open|answered|resolved|all`, `?askedTo=me|any`,
  // `?type=<record type>`. Every other parameter (`?stack=` of the object panel) passes through; the page
  // ignores values it does not offer.
  validateSearch: (
    search: Record<string, unknown>,
  ): Record<string, unknown> & { status?: string; askedTo?: string; type?: string } => ({
    ...search,
    status: text(search.status),
    askedTo: text(search.askedTo),
    type: text(search.type),
  }),
  component: PageComponent,
});
