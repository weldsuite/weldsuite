import { createFileRoute, redirect } from '@tanstack/react-router';

// A fixed asset opens in the shared object panel on the asset register; the
// old detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/fixed-assets/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/fixed-assets?stack=fixed_asset:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
