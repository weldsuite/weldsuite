import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldreach/mailboxes/page';
import '@/lib/breadcrumbs/types';

/** `?billing=done` marks the return from Stripe Checkout after adding a payment method. */
export const Route = createFileRoute('/weldreach/mailboxes/')({
  validateSearch: (search: Record<string, unknown>): { billing?: string } => ({
    billing: typeof search.billing === 'string' ? search.billing : undefined,
  }),
  staticData: { breadcrumb: { labelKey: 'mailboxesAndDomains' } },
  component: PageComponent,
});
