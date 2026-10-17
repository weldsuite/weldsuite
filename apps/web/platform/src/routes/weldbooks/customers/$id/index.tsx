import { createFileRoute, redirect } from '@tanstack/react-router';

// A contact opens in the shared object panel on the customers list; the old
// detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/customers/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/customers?stack=weldbooks_contact:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
