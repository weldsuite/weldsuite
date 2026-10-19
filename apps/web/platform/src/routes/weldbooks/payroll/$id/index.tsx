import { createFileRoute, redirect } from '@tanstack/react-router';

// A payroll run opens in the shared object panel on the payroll list; the old
// detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/payroll/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/payroll?stack=payroll_run:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
