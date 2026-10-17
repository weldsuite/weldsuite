import { createFileRoute, redirect } from '@tanstack/react-router';

// A bank account opens in the shared object panel on the accounts list; the
// old detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/banking/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/banking?stack=bank_account:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
