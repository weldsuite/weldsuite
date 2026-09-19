import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldcommerce/products/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/apps/weldcommerce/products${location.searchStr}${location.hash}` });
  },
});
