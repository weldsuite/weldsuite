import { createFileRoute, redirect } from '@tanstack/react-router';

// An invoice (or credit note) opens in the shared object panel on the invoice
// list; the old detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/invoices/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/invoices?stack=invoice:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
