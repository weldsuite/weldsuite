import { createFileRoute, redirect } from '@tanstack/react-router';
import { validateReachSettingsSearch } from '@/app/weldreach/components/use-payment-method-setup';

// WeldReach configuration lives with the other apps on the workspace settings
// page. This path stays so existing links, and a Stripe Checkout started
// before the move, keep working.
export const Route = createFileRoute('/weldreach/settings/')({
  validateSearch: validateReachSettingsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/settings/apps/weldreach', search, replace: true });
  },
});
