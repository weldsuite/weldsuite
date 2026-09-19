import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldcommerce/orders/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/apps/weldcommerce/orders${location.searchStr}${location.hash}` });
  },
});
