import { createFileRoute, redirect } from '@tanstack/react-router';

// A bill opens in the shared object panel on the bills list; the old detail
// URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/bills/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/bills?stack=bill:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
