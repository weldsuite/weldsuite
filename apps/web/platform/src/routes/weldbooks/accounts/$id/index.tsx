import { createFileRoute, redirect } from '@tanstack/react-router';

// A ledger account opens in the shared object panel on the chart of accounts;
// the old detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/accounts/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/accounts?stack=ledger_account:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
