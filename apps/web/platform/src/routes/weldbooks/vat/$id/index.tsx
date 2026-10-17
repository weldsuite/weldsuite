import { createFileRoute, redirect } from '@tanstack/react-router';

// A VAT return opens in the shared object panel on the VAT returns list; the
// old detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/vat/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/vat?stack=vat_return:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
