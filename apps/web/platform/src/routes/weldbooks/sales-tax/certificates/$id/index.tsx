import { createFileRoute, redirect } from '@tanstack/react-router';

// An exemption certificate opens in the shared object panel on the certificates
// list; the old detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/sales-tax/certificates/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/sales-tax/certificates?stack=tax_exemption_certificate:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
