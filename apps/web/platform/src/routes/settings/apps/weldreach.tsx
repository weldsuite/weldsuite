import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldreach/page';
import { validateReachSettingsSearch } from '@/app/weldreach/components/use-payment-method-setup';

/** `?billing=done` marks the return from Stripe Checkout after updating the payment method. */
export const Route = createFileRoute('/settings/apps/weldreach')({
  validateSearch: validateReachSettingsSearch,
  component: PageComponent,
});
