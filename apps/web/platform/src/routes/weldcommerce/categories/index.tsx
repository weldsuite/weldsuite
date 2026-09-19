import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldcommerce/categories/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/apps/weldcommerce/categories${location.searchStr}${location.hash}` });
  },
});
