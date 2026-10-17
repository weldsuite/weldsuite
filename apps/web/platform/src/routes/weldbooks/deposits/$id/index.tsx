import { createFileRoute, redirect } from '@tanstack/react-router';

// A deposit opens in the shared object panel on the deposits list; the old
// detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/deposits/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/deposits?stack=deposit:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
