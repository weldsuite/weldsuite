import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Legacy first-party WeldCommerce URLs → hosted WeldApp.
 * SPA pages were removed; commerce lives at `/apps/weldcommerce`.
 */
export const Route = createFileRoute('/weldcommerce')({
  beforeLoad: ({ location }) => {
    const rest = location.pathname.replace(/^\/weldcommerce\/?/, '');
    const target = rest ? `/apps/weldcommerce/${rest}` : '/apps/weldcommerce';
    throw redirect({ href: `${target}${location.searchStr}${location.hash}` });
  },
  component: () => null,
});
