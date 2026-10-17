import { createFileRoute, redirect } from '@tanstack/react-router';

// A payment run opens in the shared object panel on the payment runs list; the
// old detail URL lands there with the panel expanded to fullscreen. The checks
// page below it stays a page.
export const Route = createFileRoute('/weldbooks/payment-runs/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/payment-runs?stack=payment_run:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
