import { createFileRoute, redirect } from '@tanstack/react-router';

// A sales tax agency opens in the shared object panel on the agencies list; the
// old detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/sales-tax/agencies/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/sales-tax/agencies?stack=sales_tax_agency:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
