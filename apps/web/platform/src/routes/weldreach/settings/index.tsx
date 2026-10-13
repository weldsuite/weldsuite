import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldreach/settings/page';
import '@/lib/breadcrumbs/types';

/** `?billing=done` marks the return from Stripe Checkout after updating the payment method. */
export const Route = createFileRoute('/weldreach/settings/')({
  validateSearch: (search: Record<string, unknown>): { billing?: string } => ({
    billing: typeof search.billing === 'string' ? search.billing : undefined,
  }),
  staticData: { breadcrumb: { label: 'Settings' } },
  component: PageComponent,
});
