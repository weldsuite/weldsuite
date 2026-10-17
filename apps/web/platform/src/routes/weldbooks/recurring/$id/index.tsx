import { createFileRoute, redirect } from '@tanstack/react-router';

// A recurring invoice template opens in the shared object panel on the
// recurring list; the old detail URL lands there with the panel expanded to
// fullscreen.
export const Route = createFileRoute('/weldbooks/recurring/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/recurring?stack=recurring_invoice:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
