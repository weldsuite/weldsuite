import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldreach/setup/page';
import '@/lib/breadcrumbs/types';

/**
 * `?step=` is the wizard step (so Back works and Stripe can return to the
 * payment step); `?billing=done` marks the return from Stripe Checkout.
 */
export const Route = createFileRoute('/weldreach/setup/')({
  validateSearch: (search: Record<string, unknown>): { step?: string; billing?: string } => ({
    step: typeof search.step === 'string' ? search.step : undefined,
    billing: typeof search.billing === 'string' ? search.billing : undefined,
  }),
  staticData: { breadcrumb: { labelKey: 'setUp' } },
  component: PageComponent,
});
