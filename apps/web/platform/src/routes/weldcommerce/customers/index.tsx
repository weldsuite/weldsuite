import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldcommerce/customers/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/apps/weldcommerce/customers${location.searchStr}${location.hash}` });
  },
});
